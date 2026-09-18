/**
 * 回合内未知工具调用的循环守卫。
 *
 * 背景：模型偶发编造一个不存在的工具名（幻觉）本身不是致命问题，一次失败即换工具
 * 就无事。致命的是放大：失败的 tool_use 与 tool_result 成对留在历史里，每次请求
 * 都把这组记录喂回给模型，模型看到「我上次调过这个工具」，于是按「参数写错了」
 * 而非「工具不存在」理解，下一轮继续发，且发得更多。
 *
 * 2026-09-15 的实测现场（session 20260915035633-8f4c66）里，一条 assistant 消息
 * 内含 56 个同一幻觉工具名的 tool_use，到循环后期单条消息内出现几十次。全程没有
 * 任何机制把它截断。
 *
 * 设计原则与 continuation.ts 一致：**能用确定性判据的地方绝不用阈值。**
 * 本模块的判据是纯二值的——`errorCode === 'UNKNOWN_TOOL'`，不含任何文本相似度
 * 或调用次数统计。次数只作为终止点，不参与「是否病态」的判断。
 *
 * 判据边界（改这个模块前必读）：
 * 只认「工具名未注册」，**不认同一工具名、同一参数、连续 N 次调用**。
 * 「工具存在但执行失败」可能是合法重试（改参数、临时故障），必须一律放行。
 * 典型合法场景是外部状态不对时先读一次、第二次确认，同工具同参数连续两次都正常。
 * 若把判据放宽到「重复调用」，这类场景会被误杀。
 *
 * 完整设计与实测依据见内部产品设计文档（上下文层对工具幻觉的放大机制与对齐设计）。
 */

/** 连续命中多少次未知工具即终止回合。 */
export const UNKNOWN_TOOL_LIMIT = 3;

/**
 * 为什么是 3 而不是 1：模型偶尔打错一个工具名是可能的，一次就终止会把正常的
 * 笔误变成硬错误。为什么不是 5 或 8：纯劝告式的重复提醒可以用多档阈值做渐进
 * 提示，本模块是终止式的，只需一个终止点。且重复调用的判据（参数完全相同）与
 * 工具名不存在不同，后者一旦连续发生就不该再给机会。
 */

/** 守卫判定结果。safe=true 表示可以继续本回合。 */
export type UnknownToolVerdict =
  | { safe: true }
  | {
      safe: false;
      /** 已连续命中的次数，等于 UNKNOWN_TOOL_LIMIT。 */
      count: number;
      /** 触发终止的那个工具名，用于透传给用户的错误说明。 */
      lastName: string;
    };

/** 守卫状态：当前已连续命中的次数与最近一次的工具名。 */
export interface UnknownToolState {
  streak: number;
  lastName: string;
}

/** 空状态。每个回合开始时用。 */
export function emptyUnknownToolState(): UnknownToolState {
  return { streak: 0, lastName: '' };
}

/**
 * 记入一次工具结果，返回新状态。
 *
 * 只有 `UNKNOWN_TOOL` 计入连续命中。任何其他结果（成功、工具存在但失败、
 * 用户中断、参数校验失败）都把计数清零——它们证明模型还在用真实存在的工具，
 * 链条已断。
 */
export function recordToolOutcome(
  state: UnknownToolState,
  errorCode: string | undefined,
  toolName: string,
): UnknownToolState {
  if (errorCode !== 'UNKNOWN_TOOL') {
    return state.streak === 0 && state.lastName === ''
      ? state
      : { streak: 0, lastName: '' };
  }
  return { streak: state.streak + 1, lastName: toolName };
}

/** 判定当前是否已到终止点。 */
export function checkUnknownToolSafety(
  state: UnknownToolState,
  limit: number = UNKNOWN_TOOL_LIMIT,
): UnknownToolVerdict {
  if (state.streak >= limit) {
    return { safe: false, count: state.streak, lastName: state.lastName };
  }
  return { safe: true };
}
