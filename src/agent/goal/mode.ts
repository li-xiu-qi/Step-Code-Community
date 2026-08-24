import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { t } from '../../i18n.js';
import { billedTokens } from '../compaction/compact.js';

/** goal（自主目标）状态：active / paused / blocked（complete 瞬态即清）。 */
export type GoalStatus = 'active' | 'paused' | 'blocked';

export interface GoalState {
  /** 唯一标识（创建时生成）。 */
  id: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  /** 轮次预算（可选，超支 markBlocked）。 */
  turnBudget?: number;
  /** 已用 token（计费口径累计：input - cache_read + output）。 */
  tokensUsed: number;
  /** token 预算（可选，超支 markBlocked）。 */
  tokenBudget?: number;
  terminalReason?: string;
  /** 创建时间戳（ms），用于状态栏徽标与面板展示墙钟用时。 */
  createdAt: number;
  /** 最后更新时间戳（ms），乐观锁用：跨 session 并发写时检测冲突。 */
  updatedAt: number;
}

/** goal 生命周期事件：created / updated（暂停、恢复、阻塞）/ completed（瞬态完成，携带清除前快照）。 */
export type GoalChangeEvent =
  | { type: 'created'; goal: GoalState }
  | { type: 'updated'; goal: GoalState }
  | { type: 'completed'; goal: GoalState };

/** 预算使用比例达到该值时，reminder 追加收敛提示。 */
const NEAR_BUDGET_RATIO = 0.75;

/** goal 管理器：持有当前 goal，状态机 + 预算判定 + 生命周期事件。 */
export class GoalMode {
  private goal: GoalState | null = null;
  private listener: ((ev: GoalChangeEvent) => void) | null = null;

  /** 注册生命周期监听器（UI 层打 marker、刷状态栏）；传 null 解除。 */
  setOnChange(fn: ((ev: GoalChangeEvent) => void) | null): void {
    this.listener = fn;
  }

  private emit(ev: GoalChangeEvent): void {
    this.listener?.(ev);
  }

  create(objective: string, completionCriterion?: string, replace = false): GoalState {
    if (this.goal !== null && !replace) {
      throw new Error('已有进行中的 goal。先 UpdateGoal 结束，或带 replace 覆盖。');
    }
    const now = Date.now();
    this.goal = { id: randomUUID(), objective, completionCriterion, status: 'active', turnsUsed: 0, tokensUsed: 0, createdAt: now, updatedAt: now };
    this.emit({ type: 'created', goal: { ...this.goal } });
    return this.goal;
  }

  get(): GoalState | null {
    return this.goal;
  }

  update(status: 'active' | 'paused' | 'blocked' | 'complete', reason?: string): void {
    if (this.goal === null) throw new Error('当前没有 goal。');
    if (status === 'complete') {
      // updatedAt 不在此处设置：由 GoalStore.save() 统一设为 Date.now()，
      // 否则快照的时间戳比磁盘新，乐观锁会误判冲突。
      const snapshot: GoalState = { ...this.goal, terminalReason: reason };
      this.goal = null; // 瞬态：完成即清
      this.emit({ type: 'completed', goal: snapshot });
      return;
    }
    this.goal.status = status;
    this.goal.terminalReason = reason;
    this.emit({ type: 'updated', goal: { ...this.goal } });
  }

  setTurnBudget(n: number): void {
    if (this.goal === null) throw new Error('当前没有 goal。');
    this.goal.turnBudget = n;
  }

  setTokenBudget(n: number): void {
    if (this.goal === null) throw new Error('当前没有 goal。');
    this.goal.tokenBudget = n;
  }

  /**
   * 更新落盘时间戳（由持久化层在 save 成功后调用）。
   *
   * update() 不触碰 updatedAt，否则乐观锁会在每次 save 后失效。
   * 只有 GoalStore.save() 写入后才调用此方法，让内存中的 updatedAt 与磁盘同步。
   */
  touchUpdatedAt(ts: number): void {
    if (this.goal !== null) this.goal.updatedAt = ts;
  }

  incrementTurn(): void {
    if (this.goal !== null && this.goal.status === 'active') this.goal.turnsUsed += 1;
  }

  /**
   * 按计费口径累计 token（goal active 才累计，paused/blocked 不累计）：
   * 缓存命中不计成本，故 input 扣除 cache_read 后加 output。
   */
  addTokens(usage: Anthropic.Usage): void {
    if (this.goal === null || this.goal.status !== 'active') return;
    this.goal.tokensUsed += billedTokens(usage);
  }

  /** 哪种预算耗尽（turns / tokens），都没超返回 null。 */
  exceededBudget(): 'turns' | 'tokens' | null {
    if (this.goal === null) return null;
    if (this.goal.turnBudget !== undefined && this.goal.turnsUsed >= this.goal.turnBudget) return 'turns';
    if (this.goal.tokenBudget !== undefined && this.goal.tokensUsed >= this.goal.tokenBudget) return 'tokens';
    return null;
  }

  /** 是否超预算（轮次或 token 任一）。 */
  overBudget(): boolean {
    return this.exceededBudget() !== null;
  }

  /** 导出当前 goal 快照（随会话持久化用）；无 goal 返回 null。 */
  snapshot(): GoalState | null {
    return this.goal === null ? null : { ...this.goal };
  }

  /**
   * 从持久化存储恢复 goal（挂载 /resume 时调用）。
   * Goal 已独立持久化,无需通过状态降级防止进程重启后自动续跑;
   * active / paused / blocked 原样保留。静默恢复,不发生生命周期事件。
   */
  restore(state: GoalState | null | undefined): void {
    if (state === null || state === undefined) {
      this.goal = null;
      return;
    }
    this.goal = { ...state };
  }

  /** goal 激活时应续跑的提示（模型自报停机的替身）。 */
  continuationPrompt(): string {
    return (
      '继续朝当前目标推进。每轮完成一个连贯的工作切片并自审：' +
      '若目标已达成、或遇到无法自行解决的阻塞，调用 update_goal 标记 complete 或 blocked，不要再空跑。' +
      '不要只产出计划或摘要就标记 complete。'
    );
  }

  /** 注入上下文的 goal 提醒（防注入包裹）：已用轮次/token/剩余，预算将尽时追加收敛提示。 */
  reminder(): string {
    if (this.goal === null) return '';
    const g = this.goal;
    const crit = g.completionCriterion !== undefined ? `\n完成标准：${g.completionCriterion}` : '';
    const turns =
      g.turnBudget !== undefined ? `${g.turnsUsed} / 预算 ${g.turnBudget}（剩余 ${g.turnBudget - g.turnsUsed}）` : `${g.turnsUsed}`;
    const tokens =
      g.tokenBudget !== undefined
        ? `${g.tokensUsed} / 预算 ${g.tokenBudget}（剩余 ${g.tokenBudget - g.tokensUsed}）`
        : `${g.tokensUsed}`;
    const near =
      (g.turnBudget !== undefined && g.turnsUsed >= g.turnBudget * NEAR_BUDGET_RATIO) ||
      (g.tokenBudget !== undefined && g.tokensUsed >= g.tokenBudget * NEAR_BUDGET_RATIO);
    const warning = near ? `\n${t('goal.budgetWarning')}` : '';
    return `<goal status="${g.status}">\n目标：<untrusted_objective>${escapeXml(g.objective)}</untrusted_objective>${crit}\n已用轮次：${turns}\n已用 token：${tokens}${warning}\n</goal>`;
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
