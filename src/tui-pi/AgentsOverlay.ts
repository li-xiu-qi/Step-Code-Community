/**
 * ④ `/agents` 分组面板：当前会话派生的子 agent 总览。
 *
 * 多子 agent 并跑时，进度嵌在各自的 spawn_agent 卡片里，缺少"总览"。本面板列出
 * 当前会话所有子 agent（运行中 + 已完成），实时更新。选中后进入只读浏览（复用 ③ 的
 * browseSubagentSession 路径）。
 *
 * 与 TasksOverlay 同款挂载路径：tui.showOverlay + 1 秒 tick 驱动重渲。
 * 数据每帧从 getAgents() 现取（SubagentStore.list），运行中子 agent 的进度靠 runner
 * 每轮 saveSnapshot 刷新，延迟 ≤ 1 轮。
 */
import { matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import type { SessionMeta } from '../session/store.js';
import { c } from './theme.js';

/** 排序：运行中在前，其余按 updatedAt 倒序。 */
export function sortAgents(agents: readonly SessionMeta[]): SessionMeta[] {
  const order: Record<string, number> = { running: 0, done: 1, error: 2, aborted: 3 };
  return [...agents].sort((a, b) => {
    const d = (order[a.status ?? ''] ?? 9) - (order[b.status ?? ''] ?? 9);
    if (d !== 0) return d;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

/** 单行子 agent 摘要：状态 · 类型 · 名称 · 消息数 · id。按 depth 缩进显示层级。 */
export function agentRow(agent: SessionMeta, selected: boolean, width: number, depth?: number): string {
  const mark =
    agent.status === 'running'
      ? c.warn('●')
      : agent.status === 'done'
        ? c.ok('✓')
        : agent.status === 'error'
          ? c.error('✗')
          : c.dim('·');
  const sel = selected ? c.toolName('›') : ' ';
  // 树形缩进：每层 2 空格 + 连接线
  const indent = depth !== undefined && depth > 0 ? '  │ '.repeat(depth - 1) + '  ├─ ' : ' ';
  const type = c.accent(agent.agentType ?? 'general');
  const label = c.dim(agent.name ?? agent.title ?? agent.id.slice(0, 8));
  const msgs = c.dim(`${agent.messageCount} 条`);
  const head = `${sel}${indent}${mark} ${type} ${label}  ${msgs}`;
  return truncateToWidth(head, width);
}

export class AgentsOverlay implements Component {
  private sel = 0;
  private filter = '';
  private filterActive = false;
  /** 被折叠的 depth 层级（及其所有子级都被隐藏）。 */
  private collapsedDepths = new Set<number>();
  private readonly getAgents: () => readonly SessionMeta[];
  private readonly onBrowse: (id: string) => void;
  /**
   * 可选：Enter 的替代动作（接管对话而非只读浏览）。
   * 提供时 Enter 走它，未提供时维持 onBrowse——/agents 是只读下钻入口，
   * 无参 /handoff 是切换入口，两者共用面板但 Enter 语义不同。
   */
  private readonly onHandoff?: (id: string) => void;
  private readonly requestRender: () => void;
  private readonly close: () => void;

  constructor(opts: {
    getAgents: () => readonly SessionMeta[];
    /** 只读下钻动作。handoff 模式下不需要，传空函数即可。 */
    onBrowse: (id: string) => void;
    requestRender: () => void;
    onClose: () => void;
    onHandoff?: (id: string) => void;
  }) {
    this.getAgents = opts.getAgents;
    this.onBrowse = opts.onBrowse;
    this.onHandoff = opts.onHandoff;
    this.requestRender = opts.requestRender;
    this.close = opts.onClose;
  }

  private visible(): SessionMeta[] {
    const all = sortAgents(this.getAgents());
    if (this.filter === '') return all;
    const q = this.filter.toLowerCase();
    return all.filter((m) => {
      const haystack = `${m.id} ${m.agentType ?? ''} ${m.title ?? ''} ${m.name ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  /** 过滤掉被折叠层级的子代理。 */
  private visibleFlat(): SessionMeta[] {
    const all = this.visible();
    if (this.collapsedDepths.size === 0) return all;
    return all.filter((m) => {
      const d = m.depth ?? 0;
      // 检查该 depth 的直接父级是否被折叠
      if (d <= 0) return true;
      // 如果 depth-1 层被折叠，则此节点不可见
      for (const cd of this.collapsedDepths) {
        if (d > cd && all.some((p) => (p.depth ?? 0) === cd && p.id !== m.id)) return false;
      }
      return true;
    });
  }

  private applyFilter(ch: string): void {
    if (ch === '\b' || ch === '\x7f') {
      this.filter = this.filter.slice(0, -1);
    } else if (ch.length === 1 && ch >= ' ') {
      this.filter += ch;
    }
  }

  handleInput(data: string): void {
    if (this.filterActive) {
      if (matchesKey(data, 'escape')) {
        this.filterActive = false;
        this.requestRender();
        return;
      }
      if (matchesKey(data, 'return')) {
        this.filterActive = false;
        this.sel = 0;
        this.requestRender();
        return;
      }
      if (data === '\b' || data === '\x7f') {
        this.applyFilter(data);
        this.sel = 0;
        this.requestRender();
        return;
      }
      if (data.length === 1 && data >= ' ') {
        this.applyFilter(data);
        this.sel = 0;
        this.requestRender();
        return;
      }
      return;
    }

    const list = this.visibleFlat();
    if (matchesKey(data, 'escape') || data === 'q') {
      this.close();
      return;
    }
    if (data === '/') {
      this.filterActive = true;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'left')) {
      // 折叠当前选中项的层级
      const agent = list[this.sel];
      if (agent !== undefined && (agent.depth ?? 0) > 0) {
        this.collapsedDepths.add(agent.depth!);
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'right')) {
      // 展开当前选中项的父级
      const agent = list[this.sel];
      if (agent !== undefined && (agent.depth ?? 0) > 0) {
        this.collapsedDepths.delete(agent.depth!);
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') {
      this.sel = Math.max(0, this.sel - 1);
    } else if (matchesKey(data, 'down') || data === 'j') {
      this.sel = Math.min(Math.max(0, list.length - 1), this.sel + 1);
    } else if (matchesKey(data, 'return')) {
      const agent = list[this.sel];
      if (agent !== undefined) {
        // 接管对话优先：提供了 onHandoff 时 Enter 是切换动作，不是只读浏览
        if (this.onHandoff !== undefined) {
          this.onHandoff(agent.id);
          return;
        }
        this.onBrowse(agent.id);
        return;
      }
    }
    this.requestRender();
  }

  /** 选中子 agent 的详情栏。 */
  private renderDetail(agent: SessionMeta, width: number): string[] {
    const rows: Array<{ label: string; value: string; color?: (s: string) => string }> = [
      { label: 'id', value: agent.id },
      { label: '类型', value: agent.agentType ?? 'general' },
      { label: '状态', value: agent.status ?? '未知', color: (s) => this.statusColor(agent.status ?? '', s) },
      { label: '消息', value: String(agent.messageCount) },
      // 归属决定能否 /handoff 接管：主 agent 编排产物只读，用户自己 fork 出来的才能直连。
      // 缺省按 agent（旧快照无此字段）——默认锁死，不主动放开。
      {
        label: '归属',
        value: agent.owner === 'user' ? '你的（可接管）' : '主 agent 的（只读）',
        color: (s) => (agent.owner === 'user' ? c.ok(s) : c.dim(s)),
      },
    ];
    if (agent.name !== undefined || agent.title !== undefined) {
      rows.push({ label: '任务', value: agent.name ?? agent.title ?? '' });
    }
    if (agent.preview !== undefined && agent.preview !== '') {
      rows.push({ label: '首条', value: agent.preview });
    }
    const out: string[] = [];
    for (const r of rows) {
      const prefix = c.dim(`${r.label}: `);
      const value = r.color !== undefined ? r.color(r.value) : r.value;
      out.push(truncateToWidth(`  ${prefix}${value}`, width));
    }
    return out;
  }

  private statusColor(status: string, value: string): string {
    switch (status) {
      case 'running': return c.warn(value);
      case 'done': return c.ok(value);
      case 'error': return c.error(value);
      default: return c.dim(value);
    }
  }

  render(width: number): string[] {
    const list = this.visibleFlat();
    const all = this.visible();
    const out: string[] = [
      c.accent(truncateToWidth(`子 agent 总览（${list.length} / ${all.length} 个，← → 折叠展开）`, width)),
    ];
    if (this.filterActive) {
      out.push(c.dim(truncateToWidth(`过滤: ${this.filter}█`, width)));
      out.push('');
    }
    if (list.length === 0) {
      out.push(c.dim(truncateToWidth(this.filter !== '' ? '无匹配结果' : '本会话还没有派生过子 agent', width)));
    } else {
      const sel = Math.min(this.sel, Math.max(0, list.length - 1));
      for (const [i, agent] of list.entries()) {
        out.push(agentRow(agent, i === sel, width, agent.depth));
      }
      const agent = list[sel];
      if (agent !== undefined) {
        out.push('');
        out.push(...this.renderDetail(agent, width));
      }
    }
    if (this.filterActive) {
      out.push(c.dim(truncateToWidth('输入过滤文字 · Enter 确认 · Esc 取消', width)));
    } else {
      // 提示文案跟着 Enter 的实际动作走：handoff 模式写「接管对话」，否则用户会以为只是看看
      const enterHint = this.onHandoff !== undefined ? 'Enter 接管对话' : 'Enter 浏览';
      out.push(c.dim(truncateToWidth(`↑↓/jk 选择 · ${enterHint} · ←→ 折叠 · / 过滤 · Esc 关闭`, width)));
    }
    return out;
  }

  invalidate(): void {
    // 数据每帧从 getAgents() 现取，无缓存
  }
}
