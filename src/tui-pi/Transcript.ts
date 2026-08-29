/**
 * 转录区容器：持有全部消息块，并提供一个「安全阀」级别的裁剪。
 *
 * 裁剪策略是被实测推翻后重定的（数据见设计档案「M1 实测记录」）：
 * 原计划做两级裁剪（按轮数上限 + 轮内折叠），但实测发现**任何裁剪都必然触发一次
 * 全屏重绘并清掉 scrollback**——裁剪删的是最老的行，删完所有内容上移，首个变化行落在
 * 上一帧视口顶部之上，pi-tui 的差分渲染此时只有 `fullRender(true)` 一条路，
 * 而它带 CSI 3J。关掉 clearOnShrink 挡不住这条路径（那个开关只管「内容变短」这一种触发）。
 *
 * 反过来，不裁剪的成本实测很低：12000 行历史（约 3000 轮）下流式单帧 3.47ms、零全量重绘。
 * 在 50ms 合帧节奏下这是 7% 的帧预算。所以默认不裁剪，保留 maxTurns 作为防内存失控的
 * 安全阀（默认 2000 轮），只有跑到那个量级才接受一次清屏。
 */
import { truncateToWidth, type Component } from '@earendil-works/pi-tui';
import type { DisplayItem } from '../chat/types.js';
import { ItemBlock } from './blocks.js';
import { c } from './theme.js';

/** 安全阀：保留的最近 turn 数。默认值高到日常用不到，纯防内存失控。 */
export const DEFAULT_MAX_TURNS = 2000;
/** 迟滞：超过 maxTurns + 迟滞才裁一次，避免每轮都动组件树。 */
export const TURN_HYSTERESIS = 50;
/** 单个 turn 内保留的块数上限（同为安全阀，日常回合远达不到）。 */
export const DEFAULT_MAX_BLOCKS_PER_TURN = 2000;
/** 日常滑动窗口：超过此 turn 数时触发温和折叠（foldOldTurns），保留 foldSummary 占位。
 *  <= dailyWindowSize: 无动作
 *  dailyWindowSize ~ maxTurns: 折叠旧 turn 为摘要（温和，保留 foldSummary 占位）
 *  > maxTurns + hysteresis: 硬裁剪（trim 丢弃块，安全阀）
 */
export const DEFAULT_DAILY_WINDOW = 100;

export interface TranscriptOptions {
  maxTurns?: number;
  maxBlocksPerTurn?: number;
  dailyWindowSize?: number;
}

export class Transcript implements Component {
  private blocks: ItemBlock[] = [];
  private readonly maxTurns: number;
  private readonly maxBlocksPerTurn: number;
  private readonly dailyWindowSize: number;
  /** 被裁掉的轮数累计（>0 时顶部显示一行折叠提示）。 */
  private foldedTurns = 0;
  /** 被折叠的块数累计（turn 内裁剪产生）。 */
  private foldedBlocks = 0;
  /**
   * 并行子 agent 计数（头部显示，非折叠提示）。由消费方按 start/end 事件维护——Transcript
   * 自己不扫描块（那是 O(N)/帧，且与 prefixCache 的冻结前提冲突）。
   * 只记运行中数：终态数从卡片上看得见，头部要回答的是「还有几个在跑」。
   */
  private runningSubagents = 0;
  /**
   * 结构版本号：块数组发生结构性变化（push/reset/折叠/裁剪）时自增；尾块的内容变更不递增。
   * 与 prefixCache 配套——render 时据此判断「非尾块的冻结前缀是否仍有效」。尾块是流式追加与
   * 工具状态回填的唯一热变更目标，它的变化不该让前缀缓存每帧失效，否则冻结形同虚设。
   */
  private structVer = 0;
  /** 自动递增的 turn 编号：push 时给无 turnNum 的 user 消息补齐（实时对话 / bash 输入）。 */
  private nextTurnNum = 0;
  /** 冻结前缀缓存：head 提示行 + 除尾块外全部块的渲染结果。尾块每帧重渲，前缀仅结构变化时重算。 */
  private prefixCache: { width: number; ver: number; lines: string[] } | null = null;

  constructor(options: TranscriptOptions = {}) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxBlocksPerTurn = options.maxBlocksPerTurn ?? DEFAULT_MAX_BLOCKS_PER_TURN;
    this.dailyWindowSize = options.dailyWindowSize ?? DEFAULT_DAILY_WINDOW;
  }

  invalidate(): void {
    for (const b of this.blocks) b.invalidate();
  }

  /** 当前块数（测试与调试用）。 */
  size(): number {
    return this.blocks.length;
  }

  items(): DisplayItem[] {
    return this.blocks.map((b) => b.getItem());
  }

  push(item: DisplayItem): void {
    if (item.kind === 'user' && item.turnNum === undefined) {
      item = { ...item, turnNum: ++this.nextTurnNum };
    }
    this.blocks.push(new ItemBlock(item));
    this.structVer++;
    this.trim();
  }

  /** 整体替换（/new、/resume、历史回放）。 */
  reset(items: readonly DisplayItem[], foldedTurns = 0): void {
    this.blocks = items.map((it) => new ItemBlock(it));
    this.foldedTurns = foldedTurns;
    this.foldedBlocks = 0;
    this.structVer++;
  }

  /**
   * 撤回从 index 起的全部块（含）：PreOutput 拦截时移除本次尝试已上屏的残文。
   *
   * 必须递增 structVer：差分渲染靠它判定冻结前缀是否失效，若不递增，前缀缓存沿用旧值，
   * 表现为「块已删、屏幕上还在」（2026-08-25 真机：拦截提示排在违规正文之后即此因）。
   * 被删块 dispose 释放 markdown 渲染缓存；越界或空区间为空操作。
   */
  retractFrom(index: number): void {
    if (index < 0) return; // 负下标无意义（撤回起点不能早于表头），空操作；勿钳到 0，否则 splice 会清空全表
    if (index >= this.blocks.length) return; // 越界：空操作
    const removed = this.blocks.splice(index);
    for (const b of removed) b.dispose();
    this.structVer++;
  }

  /** 原地更新第 index 块（负数从尾部数）。越界为空操作。 */
  update(index: number, item: DisplayItem): void {
    const i = index < 0 ? this.blocks.length + index : index;
    if (this.blocks[i] !== undefined) {
      this.blocks[i]!.setItem(item);
      // 非尾块的内容变更才让冻结前缀失效；尾块是流式热变更目标，它的变化由每帧重渲尾块覆盖，
      // 若也递增版本号，前缀缓存会在每个 token 失效，冻结即失效。
      if (i !== this.blocks.length - 1) this.structVer++;
    }
  }

  /**
   * 按卡片 id 原地更新（子 agent 进度归属用）。返回是否命中。
   *
   * 与 {@link updateLastWhere} 的区别：那个找「最后一个运行中的 spawn_agent」作近似，并行时
   * 多个子 agent 的进度全堆到同一张卡片（token/耗时/工具数互相覆盖）。这里按 tool_use id
   * 精确定位——runner 的 onEvent key 与 tool_start 的 id 已统一到 tu.id，同源才可归属。
   */
  updateById(id: string, next: (item: DisplayItem) => DisplayItem): boolean {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      const it = b.getItem();
      if (it.kind === 'tool' && it.id === id) {
        b.setItem(next(it));
        if (i !== this.blocks.length - 1) this.structVer++;
        return true;
      }
    }
    return false;
  }

  /** 找到最后一个满足条件的块并更新（工具状态回填用）。返回是否命中。 */
  updateLastWhere(pred: (item: DisplayItem) => boolean, next: (item: DisplayItem) => DisplayItem): boolean {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      if (pred(b.getItem())) {
        b.setItem(next(b.getItem()));
        if (i !== this.blocks.length - 1) this.structVer++;
        return true;
      }
    }
    return false;
  }

  /** 末块（流式追加正文时判断能否续接）。 */
  lastItem(): DisplayItem | undefined {
    return this.blocks[this.blocks.length - 1]?.getItem();
  }

  /**
   * 设置并行子 agent 的运行中计数（头部显示用）。消费方按 start/end 事件驱动：
   * start +1、end -1，下限钳到 0（防止事件乱序或重复 end 把计数压成负数）。
   * 不递增 structVer——计数是每帧热变更，递增会让前缀缓存每帧失效，冻结即失效。
   */
  setRunningSubagents(n: number): void {
    const next = Math.max(0, n);
    if (next === this.runningSubagents) return;
    this.runningSubagents = next;
  }

  /** 当前运行中的子 agent 数（测试与消费方自查用）。 */
  runningSubagentCount(): number {
    return this.runningSubagents;
  }

  /**
   * 逐回合折叠旧块为摘要（OOM 第二道防线，设计文档 `前端设计-pi版/20260818-Transcript逐回合折叠与块释放设计.md`）。
   *
   * 与 {@link trim} 的区别：trim 是删行（触发全屏重绘+清 scrollback，见文件头注释，仅 2000 轮安全阀用）；
   * 本方法是把旧轮次的 tool/thinking 块**折成一行摘要**并 dispose 释放渲染资源，更温和但仍减少行数。
   * 保留最近 `keepRecentTurns` 个 turn 的完整块；更早的 turn 里，user/assistant/note 保留（用户最常回看），
   * tool/thinking 折成 `foldSummary`。同一旧轮里连续的可折块合并成一个摘要。
   *
   * 返回是否真的折叠了（块数未超阈值时 no-op，接线方据此避免无谓调用）。
   *
   * 约束与代价（诚实登记）：折叠顶部旧块会改变行号，pi-tui 差分渲染可能触发一次全屏重绘 +
   * 清 scrollback（与 trim 同源的已知代价）。因此接线方应低频调用（回合边界 + 阈值保护），非每帧。
   */
  foldOldTurns(keepRecentTurns: number, triggerTurns = 0): { folded: boolean; count: number } {
    if (keepRecentTurns < 0) return { folded: false, count: 0 };
    // turn 起点 = user 块下标（与 trim 同一切分口径）
    const starts: number[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      if (this.blocks[i]!.getItem().kind === 'user') starts.push(i);
    }
    if (starts.length <= keepRecentTurns) return { folded: false, count: 0 };
    // 触发闸门：turn 数未超阈值则不折。折叠顶部旧块会改行号，可能触发一次全屏重绘+清 scrollback
    // （与 trim 同源代价），故接线方传高闸门让它只在块数严重超标时触发一次，而非每回合。
    // triggerTurns=0 = 不设闸门（turn 一超 keepRecentTurns 就折，仅供单测）。
    if (triggerTurns > 0 && starts.length <= triggerTurns) return { folded: false, count: 0 };
    // cutAt：最近 keepRecentTurns 个 turn 的起点；[0, cutAt) 都是待折叠的旧块
    const cutAt = starts[starts.length - keepRecentTurns]!;
    if (cutAt <= 0) return { folded: false, count: 0 };

    const kept: ItemBlock[] = [];
    let pending = 0;
    let totalFolded = 0;
    for (let i = 0; i < cutAt; i++) {
      const it = this.blocks[i]!.getItem();
      if (it.kind === 'tool' || it.kind === 'thinking') {
        pending++;
        totalFolded++;
        this.blocks[i]!.dispose(); // 释放 markdown 解析缓存，旧块失引用即 GC
      } else {
        // user/assistant/note 等非可折块：先落地待折摘要，再保留本块
        if (pending > 0) {
          kept.push(new ItemBlock({ kind: 'foldSummary', count: pending }));
          pending = 0;
        }
        kept.push(this.blocks[i]!);
      }
    }
    if (pending > 0) kept.push(new ItemBlock({ kind: 'foldSummary', count: pending }));
    this.blocks = [...kept, ...this.blocks.slice(cutAt)];
    this.structVer++;
    return { folded: totalFolded > 0, count: totalFolded };
  }

  /**
   * 三级内存管理（自底向上）：
   * 1. 日常滑动窗口（dailyWindowSize）：超过时折叠旧 turn 为摘要（foldOldTurns），温和保留占位；
   * 2. 安全阀（maxTurns + hysteresis）：超过时硬裁剪丢弃块，仅累计计数；
   * 3. 单 turn 块数上限（maxBlocksPerTurn）：末尾 turn 超限时丢弃最早的非首块。
   */
  private trim(): void {
    // turn 起始下标
    const starts: number[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      if (this.blocks[i]!.getItem().kind === 'user') starts.push(i);
    }

    // Tier 1: 日常滑动窗口 — 温和折叠旧 turn
    if (starts.length > this.dailyWindowSize) {
      const keepRecent = Math.floor(this.dailyWindowSize * 0.6);
      const result = this.foldOldTurns(keepRecent, this.dailyWindowSize);
      if (result.folded) {
        // 折叠后重新计算 starts（foldSummary 不是 user 块）
        starts.length = 0;
        for (let i = 0; i < this.blocks.length; i++) {
          if (this.blocks[i]!.getItem().kind === 'user') starts.push(i);
        }
      }
    }

    // Tier 2: 安全阀 — 硬裁剪
    if (starts.length > this.maxTurns + TURN_HYSTERESIS) {
      const dropTurns = starts.length - this.maxTurns;
      const cutAt = starts[dropTurns]!;
      this.blocks = this.blocks.slice(cutAt);
      this.foldedTurns += dropTurns;
      this.structVer++;
      return;
    }

    // Tier 3: 单 turn 块数上限
    const lastStart = starts.length > 0 ? starts[starts.length - 1]! : 0;
    const inTurn = this.blocks.length - lastStart;
    if (inTurn > this.maxBlocksPerTurn) {
      const drop = inTurn - this.maxBlocksPerTurn;
      this.blocks = [...this.blocks.slice(0, lastStart + 1), ...this.blocks.slice(lastStart + 1 + drop)];
      this.foldedBlocks += drop;
      this.structVer++;
    }
  }

  render(width: number): string[] {
    // head 折叠提示行：每帧重算但仅 2 行，成本可忽略；逐行钳到 width 作为安全网。
    const head: string[] = [];
    if (this.foldedTurns > 0) {
      head.push(truncateToWidth(c.dim(`· 更早的 ${this.foldedTurns} 轮已从屏幕折叠（仍在会话历史与 scrollback 中）`), width), '');
    }
    if (this.foldedBlocks > 0) {
      head.push(truncateToWidth(c.dim(`· 本轮 ${this.foldedBlocks} 个条目已折叠`), width));
    }
    // 并行子 agent 头部计数：≥2 才显示。单个时不显示——一张卡片自己会说，多一行是噪音。
    // 与 foldedTurns/foldedBlocks 同属 head，但它们触发的是结构变化（structVer++），
    // 计数是每帧热变更，故独立于前缀缓存、每帧重算（成本 1 行，与现有 head 同档）。
    if (this.runningSubagents >= 2) {
      head.push(
        truncateToWidth(
          c.dim(`· 并行运行 ${this.runningSubagents} 个子 agent`),
          width,
        ),
        '',
      );
    }

    const lastIdx = this.blocks.length - 1;
    // 冻结前缀 = 除尾块外全部块的渲染结果。判定条件 (width, structVer) 任一变化即重算：
    // width 变是终端缩放；structVer 变是非尾块/结构性变化（push/reset/折叠/裁剪/非尾块回填）。
    // 尾块的内容变更（流式正文追加、运行中工具 spinner+计时）不递增 structVer，故前缀在
    // 整个流式过程中命中缓存——这是把每帧成本从 O(全转录行数) 降到 O(尾块行数) 的关键。
    let prefix: string[];
    if (this.prefixCache !== null && this.prefixCache.width === width && this.prefixCache.ver === this.structVer) {
      prefix = this.prefixCache.lines;
    } else {
      prefix = [];
      for (let i = 0; i < lastIdx; i++) prefix.push(...this.blocks[i]!.render(width));
      this.prefixCache = { width, ver: this.structVer, lines: prefix };
    }
    // 尾块每帧重渲：assistant 正文流式追加 / 运行中工具的 spinner 帧与计时都随时间变化。
    const tail = lastIdx >= 0 ? this.blocks[lastIdx]!.render(width) : [];
    // 前缀各行由各块渲染器在冻结时已钳到 width（各 renderItem 分支逐行 truncateToWidth），
    // 同 width 下必然安全，故前缀不重复截断；尾块是热变更内容，保留一次截断作防回归安全网。
    const safeTail = tail.map((l) => truncateToWidth(l, width));
    return [...head, ...prefix, ...safeTail];
  }
}
