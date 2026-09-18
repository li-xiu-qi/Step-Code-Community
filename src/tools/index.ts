import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { askUserTool } from './askUser.js';
import { bashTool } from './bash.js';
import { monitorTool } from './monitor.js';
import { cronCreateTool, cronDeleteTool, cronListTool } from './cron.js';
import { dynamicWorkflowTool } from './dynamicWorkflow.js';
import { editFileTool } from './edit.js';
import { exitPlanModeTool } from './exitPlanMode.js';
import { globTool } from './glob.js';
import { createGoalTool, getGoalTool, setGoalBudgetTool, updateGoalTool } from './goal.js';
import {
  teamInboxTool,
  teamInitTool,
  teamMergeTool,
  teamPlanTool,
  teamSendTool,
  teamSpawnTool,
  teamStatusTool,
  teamTeardownTool,
} from './team.js';
import { grepTool } from './grep.js';
import { imageSearchTool } from './imageSearch.js';
import { listDirTool } from './listDir.js';
import { readFileTool } from './readFile.js';
import { readHistoryTool } from './readHistory.js';
import { readMediaTool } from './readMedia.js';
import { spawnAgentTool } from './spawnAgent.js';
import { subagentListTool, subagentKillTool, subagentStatusTool, subagentTraceTool, subagentTraceExportTool } from './subagentControl.js';
import { sessionInboxTool, sessionListTool, sessionSendTool } from './sessionSend.js';
import { skillTool } from './skill.js';
import { skillSearchTool } from './skillSearch.js';
import { taskListTool, taskOutputTool, taskStopTool, taskWaitTool } from './task.js';
import { todoListTool } from './todoList.js';
import { toolSearchTool } from './toolSearch.js';
import { fail, failWithCode, type ToolContext, type ToolDef, type ToolResult } from './types.js';
import type { ToolAccess } from './access.js';
import { webFetchTool } from './webFetch.js';
import { webSearchTool } from './webSearch.js';
import { writeFileTool } from './write.js';

/** 全部工具，按注册顺序。 */
const ALL_TOOLS: ToolDef<any>[] = [
  readFileTool,
  readMediaTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
  bashTool,
  monitorTool,
  webSearchTool,
  webFetchTool,
  imageSearchTool,
  spawnAgentTool,
  subagentListTool,
  subagentKillTool,
  subagentStatusTool,
  subagentTraceTool,
  subagentTraceExportTool,
  readHistoryTool,
  sessionSendTool,
  sessionListTool,
  sessionInboxTool,
  exitPlanModeTool,
  askUserTool,
  todoListTool,
  taskListTool,
  taskOutputTool,
  taskStopTool,
  taskWaitTool,
  skillTool,
  skillSearchTool,
  createGoalTool,
  updateGoalTool,
  setGoalBudgetTool,
  getGoalTool,
  teamInitTool,
  teamPlanTool,
  teamSpawnTool,
  teamSendTool,
  teamInboxTool,
  teamStatusTool,
  teamMergeTool,
  teamTeardownTool,
  cronCreateTool,
  cronListTool,
  cronDeleteTool,
  toolSearchTool,
  dynamicWorkflowTool,
];

const TOOL_MAP = new Map<string, ToolDef<any>>(ALL_TOOLS.map((t) => [t.name, t]));

/** 动态注册的工具（如 MCP 懒加载命中的工具），运行期追加。 */
const DYNAMIC_TOOLS = new Map<string, ToolDef<any>>();

/** 禁用的工具名集合（来自 config disabled_tools）。启动时由组合根注册。 */
const DISABLED_TOOLS = new Set<string>();

/** 注册禁用的工具名（启动时由组合根调用）。清空旧名单后重新填充（reload 场景）。 */
export function setDisabledTools(names: readonly string[]): void {
  DISABLED_TOOLS.clear();
  for (const n of names) DISABLED_TOOLS.add(n);
}

/** 动态注册一个工具（如 MCP 工具命中后加载）。同名覆盖。 */
export function registerDynamicTool(tool: ToolDef<any>): void {
  DYNAMIC_TOOLS.set(tool.name, tool);
}

/** 清空动态注册的工具（会话切换时）。 */
export function clearDynamicTools(): void {
  DYNAMIC_TOOLS.clear();
}

/**
 * 把工具返回的任意值规整为合法 ToolResult（信任边界）。
 * 工具若返回 undefined / 原始值 / 畸形对象，一律转成合成的 isError 结果，
 * 保证 agent 循环总能给每个 tool_use 配上一个 tool_result，绝不出现孤立 tool_use。
 */
export function coerceToolResult(value: unknown): ToolResult {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolResult).content === 'string' &&
    typeof (value as ToolResult).isError === 'boolean'
  ) {
    return value as ToolResult;
  }
  if (typeof value === 'string') {
    return { content: value, isError: false };
  }
  return fail(`工具返回了非法结果（${typeof value}），已按错误处理。`);
}

/** 生成 Anthropic Messages API 的 tools 数组。传入 names 则只取白名单内的工具（供子 agent 收窄工具集）。 */
export function toAnthropicTools(names?: readonly string[]): Anthropic.Tool[] {
  const set = names === undefined ? undefined : new Set(names);
  // 动态工具并入，但若与静态工具同名（如覆盖注册）则不重复，以静态定义为准
  const dynamic = [...DYNAMIC_TOOLS.values()].filter((t) => !TOOL_MAP.has(t.name));
  const all = [...ALL_TOOLS, ...dynamic];
  return all
    .filter((t) => !DISABLED_TOOLS.has(t.name)) // 过滤 config disabled_tools
    .filter((t) => set === undefined || set.has(t.name))
    .map((tool) => {
      const jsonSchema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
      delete jsonSchema['$schema'];
      return {
        name: tool.name,
        description: tool.description,
        input_schema: jsonSchema as Anthropic.Tool.InputSchema,
      };
    });
}

/** 全部已注册工具名（含动态注册）。 */
export function allToolNames(): string[] {
  return [...ALL_TOOLS.map((t) => t.name), ...DYNAMIC_TOOLS.keys()];
}

/**
 * 工具名是否已注册（静态表 + 动态表，与 executeTool 的 UNKNOWN_TOOL 判据同源）。
 *
 * 供 runTurn 的 4.1（无效工具调用不进历史）使用：守卫中止的调用不经过 executeTool，
 * 拿不到 errorCode，只能按名字判。判定结果必须与 executeTool 的第一分支一致，
 * 否则「执行过判定为未知」与「未执行判定为已知」会漏掉同一类调用。
 */
export function isToolRegistered(name: string): boolean {
  return TOOL_MAP.has(name) || DYNAMIC_TOOLS.has(name);
}

/**
 * 取一次工具调用的资源访问声明（供 runTurn 并行调度冲突判定）。
 * 未知工具 / 未声明 / 入参非法一律按 all（独占串行，安全退化）。
 */
export function toolAccessOf(name: string, rawInput: unknown, ctx: ToolContext): ToolAccess {
  const tool = TOOL_MAP.get(name) ?? DYNAMIC_TOOLS.get(name);
  if (tool?.access === undefined) return { kind: 'all' };
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) return { kind: 'all' };
  return tool.access(parsed.data, ctx);
}

/**
 * per-tool 声明式超时的执行包装：超时表按工具名声明，缺省走全局限额。
 *
 * 三层机制缺一层都会坏：
 * 1. abort：到点向派生的 ctx.signal 发起 abort，工具内的 fetch / 子进程能收尾；
 * 2. race：工具若没响应 signal（声明失效），超时点仍把结果交还回合，不挂死整轮——
 *    底层 promise 的后续 settle 已被 race 消费，不会变成 unhandled rejection；
 * 3. 归类：超时结果标 errorCode='TOOL_TIMEOUT'，与外部用户中断分开。用户中断时
 *    timedOut 未置位，工具自己返回的中断结果原样透传，不误标成超时。
 *
 * 不声明 timeoutMs 的工具原样执行：bash 有自管的前台超时与自动转后台，
 * monitor 本就设计为长跑，强加时限只会破坏既有语义。
 */
async function runWithToolTimeout(tool: ToolDef<any>, input: unknown, ctx: ToolContext): Promise<unknown> {
  const deadlineMs = tool.timeoutMs;
  if (deadlineMs === undefined || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return await tool.execute(input, ctx);
  }
  // 派生 signal：外部中断（用户 Esc / 回合中止）先赢，超时只是补充
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort(ctx.signal?.reason);
  if (ctx.signal?.aborted) ctrl.abort(ctx.signal.reason);
  else ctx.signal?.addEventListener('abort', onExternalAbort, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exec = tool.execute(input, { ...ctx, signal: ctrl.signal });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const reason = new Error(`工具 ${tool.name} 执行超时（上限 ${deadlineMs}ms）`);
        ctrl.abort(reason);
        reject(reason);
      }, deadlineMs);
    });
    let raced: unknown;
    try {
      raced = await Promise.race([exec, timeout]);
    } catch (e) {
      // timer 触发时 race 通常拿到 timeout 的 reject；工具若在 abort 监听器里同步
      // resolve（race 偶发先赢），下面的 timedOut 判定兜底，两条路都归一到超时。
      if (!timedOut) throw e;
      raced = undefined;
    }
    // timer 一旦触发即定性为超时，不看 race 谁赢。
    // 工具在 aborted 状态下返回的内容不可信（可能是半截输出），无条件替换。
    // timer 未触发（工具正常完成或外部中断）时原样透传，不误标。
    if (timedOut) {
      return failWithCode(
        `工具 ${tool.name} 执行超时（上限 ${deadlineMs}ms），已中止。` +
          '可稍后重试，或改用后台任务（run_in_background）等方式完成同一任务。',
        'TOOL_TIMEOUT',
      );
    }
    return raced;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 执行一次工具调用：校验入参 → 调用 execute。校验失败、未知工具、执行抛异常、
 * 返回畸形值——全部转为 ToolResult（错误以 isError 回灌），绝不抛出，
 * 以便 agent 循环把错误交还给模型自我纠正。
 *
 * 未知工具走 failWithCode 标记 `UNKNOWN_TOOL`：它与"工具存在但执行失败"是两种
 * 失效。后者可能是合法重试（改参数、临时故障），前者是模型编造了工具名，重试不可能
 * 成功，必须换工具。调度层据此区分，见 ToolResult.errorCode。
 *
 * 超时走 runWithToolTimeout：声明了 timeoutMs 的工具到点中止并标 `TOOL_TIMEOUT`。
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = TOOL_MAP.get(name) ?? DYNAMIC_TOOLS.get(name);
  if (tool === undefined) {
    return failWithCode(
      `未知工具：${name}。该工具未注册，无法调用。`
        + '请从你已收到的工具列表中改用一个存在的工具；'
        + '重复调用同一个未注册的工具名不会成功，请直接更换工具或结束任务。',
      'UNKNOWN_TOOL',
    );
  }
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`工具 ${name} 入参校验失败：${parsed.error.message}`);
  }
  try {
    return coerceToolResult(await runWithToolTimeout(tool, parsed.data, ctx));
  } catch (e) {
    return fail(`工具 ${name} 执行异常：${(e as Error).message}`);
  }
}
