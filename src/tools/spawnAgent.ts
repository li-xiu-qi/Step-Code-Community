import { z } from 'zod';
import type { SubagentResult } from '../agent/subagent/types.js';
import { subagentParallelKind } from './subagentAccess.js';
import { fail, ok, type ToolContext, type ToolDef } from './types.js';
import { resolvePath } from './fsutil.js';
import { summarizeError } from '../provider/retry.js';

const schema = z.object({
  description: z
    .string()
    .optional()
    .describe(
      '子任务简述（3-5 词），显示在用户界面的进度卡片上。' +
        '给进度卡片用的标题——短、具体、能让人一眼知道这条任务在干嘛。',
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      '完整任务描述。子 agent 看不到当前对话，所有必要背景、上下文、约束都要写进来。' +
        '含糊的 prompt 产出的结果也含糊——背景写够 3 行，子 agent 少猜 1 轮。' +
        '\n\n派生子 agent 前必须确认的环境信息（不确定就用工具查，别让子 agent 猜）：' +
        '\n- 工作目录的绝对路径' +
        '\n- 需要的运行时/工具链是否已安装及版本（如 Godot 4.6、Python 3.12、Node 20）' +
        '\n- 项目是否已初始化（如 Godot 项目是否有 project.godot、Node 项目是否有 package.json）' +
        '\n- 相关的配置文件、密钥、环境变量是否就绪' +
        '\n\n这些信息你不确定就别派——先自己用 bash/glob 查清楚，再写进 prompt。' +
        '子 agent 停下来检查环境是你的失职，不是它的错。',
    ),
  subagent_type: z
    .string()
    .optional()
    .describe(
      '子 agent 角色名。可选角色见 system prompt 的「可派生的子 agent 角色」清单；省略默认 general。',
    ),
  agent_file: z
    .string()
    .optional()
    .describe(
      '直接从指定路径的 .md 文件加载角色定义，绕过 registry。用于调试临时角色、指向 registry 目录之外的文件。' +
        '指定后 agent_file 优先，subagent_type 仅作为回落名与进度卡片显示。仅新派生生效，resume/fork 不受影响。',
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      '后台异步执行，立即返回 task_id，终态自动通知。只在你还有别的活要干、且不需要它的结果就能继续时才用。' +
        '不要后台派生后立刻 task_output 轮询或空等——那样只是白白阻塞回合，这种情况直接用前台。',
    ),
  resume: z
    .string()
    .optional()
    .describe('恢复指定 id 的子会话：从历史断点续跑（prompt 作为新指令追加）。与派生新子 agent 二选一；目标会话正在运行时会被拒绝。'),
  fork: z
    .string()
    .optional()
    .describe('从指定 id 的子会话 fork 出新会话：全量复制历史后创建独立会话继续，与 resume 二选一。fork 后的新会话有自己独立的 session id，源会话不受影响。'),
  model: z
    .string()
    .optional()
    .describe('覆盖子 agent 的模型（别名或裸 id）。优先级高于 agent 模板定义的 model，仅当次派生生效。留空则用模板默认值。'),
  scope: z
    .array(z.string())
    .optional()
    .describe(
      '本子 agent 预期会读写的文件或目录路径（相对 cwd 或绝对路径）。用于并行冲突判定：' +
        '同一轮派出的多个子 agent，scope 互不重叠的可并行执行，重叠的串行。有写权限的模板建议显式声明，' +
        '不声明则按整个 cwd 保守串行。只读子 agent（如 explore）无需声明。',
    ),
});

/**
 * 结构化结果头：让父 agent 能可靠区分「做完了」与「失败但有部分产出」，resume 决策有据可依。
 * 用纯文本 `key: value` 而非 XML 包裹——工具结果是纯文本通道，标签会和正文里的代码块混淆。
 */
function formatSubagentResult(
  subagentType: string,
  status: 'done' | 'error',
  summary: string,
  sessionId: string | undefined,
  cause?: unknown,
): string {
  const head =
    sessionId !== undefined
      ? `subagent: ${subagentType} | status: ${status} | session: ${sessionId}`
      : `subagent: ${subagentType} | status: ${status}`;
  // 失败时把真实 provider 报错摘要拼进结果：子 agent 内部的 runTurn 重试已先扛过一轮，
  // 走到 error 终态的都是重试耗尽/不可重试的硬故障。没有这段时，父 agent 与用户只看到
  // 「子 agent 执行出错，未产出结果。」，无从判断是 429 限流、上下文溢出、连接拒绝还是超时，
  // 只能靠翻 session 快照倒推（而快照不含 error cause）。cause 为空时退回原文案。
  const causeLine =
    status === 'error' && cause !== undefined ? `\n\n失败原因：${summarizeError(cause)}` : '';
  const tail =
    status === 'error' && sessionId !== undefined
      ? `\n\n（需要在它已有工作基础上继续时，用 spawn_agent 的 resume="${sessionId}" 续跑；如需带着历史另起炉灶但不影响源会话，用 fork="${sessionId}"）`
      : '';
  return `${head}\n\n${summary}${causeLine}${tail}`;
}

export const spawnAgentTool: ToolDef<z.infer<typeof schema>> = {
  name: 'spawn_agent',
  description:
    '派生一个子 agent 处理子任务（全新上下文、受限工具、只回摘要）。委派同时把大量中间过程（文件原文、搜索结果）挡在你的上下文之外——你拿回的是结论，不是一堆原始输出。\n' +
    '可选角色见 system prompt 的「可派生的子 agent 角色」清单，subagent_type 省略时用 general。\n' +
    '派生后用 subagent_list 查看运行状态，subagent_kill 删除不需要的会话，subagent_status 查看详情。\n' +
    '\n' +
    '写 prompt：\n' +
    '- 子 agent 零上下文，没看过这段对话。像给刚进门的同事交接一样写：目标是什么、你已经知道什么、具体要它做什么。\n' +
    '- 查找类任务（读某个文件、跑某条命令）：把准确路径或命令写进 prompt，别让它去搜你已经知道的东西。\n' +
    '- 调查类任务（搞清楚 X、查为什么 Y）：给问题，别给规定步骤——前提一旦不成立，预设步骤就成了累赘。\n' +
    '- 不要委派理解。别写「基于你的调研，把它实现掉」这类句式，那是把本该你做的综合推给了子 agent。任务依赖某个文件路径或行号时，自己先定位好再写进 prompt。\n' +
    '\n' +
    '不要派生的情况：路径已知的单文件读取、2-3 个文件内的定向搜索、一两步就能做完的事——自己做更快。委派有上下文交接成本，任务够重才划算。\n' +
    '\n' +
    '派生之后：那块范围就交给它了。不要并行重做它正在做的搜索和读取，也不要中途放弃自己接管——两者都会抵消委派本身省下的上下文。\n' +
    '\n' +
    '返回串带子会话 id，需要在它已有工作基础上继续时用 resume=<id> 续跑（不新建会话、不占派生配额）。\n' +
    '如需带着历史上下文但独立推进新会话（源会话不受影响），用 fork=<id>（新建会话，历史全量复制）。\n' +
    '一次要并行几个独立子任务，在同一轮里发多个 spawn_agent，并用 scope 声明各自的目标路径；scope 互不重叠的会并行执行，重叠或未声明的串行。带依赖的多阶段编排或大批量同构 fan-out 改用 dynamic_workflow 工具。',
  schema,
  // 并行判据按「写的是不是同一个地方」而非「有没有写权限」：
  // - 只读模板（tools 不含写工具）→ {kind:'none'}，与任何 access 不冲突，多个只读
  //   子 agent 天然并行。不用 {kind:'read', path} 是因为若填 cwd，pathOverlap 对相等
  //   路径返回 true，同 cwd 的只读任务反而互相排斥。只读 agent 已被模板限制为不可写，
  //   用 none 是安全的。
  // - 有写工具的模板 → {kind:'write'}，路径取入参 scope（模型显式声明的目标路径）。
  //   同轮派出的多个写 agent，scope 不重叠的并行，重叠或未声明的串行。未声明时退化
  //   为整个 cwd 保守串行——不知道会写哪里，就不猜。
  access: (input, ctx) => {
    if (subagentParallelKind(ctx.cwd, input.subagent_type ?? 'general', input.agent_file) !== 'read') {
      const scope = input.scope ?? [];
      if (scope.length > 0) {
        // 多个路径时取第一个作为 access 锚点：冲突判定是两两比较，锚点不重叠即放行。
        // 同一 agent 声明多个互不重叠的 scope 时，与另一 agent 的逐个比较仍正确。
        return { kind: 'write', path: resolvePath(ctx.cwd, scope[0]!) };
      }
      // 未声明 scope：不知道会写哪里，按整个 cwd 保守串行。
      return { kind: 'write', path: resolvePath(ctx.cwd, '.') };
    }
    return { kind: 'none' };
  },
  async execute(input, ctx) {
    if (ctx.runSubagent === undefined) {
      return fail('当前上下文不支持派生子 agent（子 agent 内不能再派生）。请自己完成该任务。');
    }

    const subagentType = input.subagent_type ?? 'general';
    const prompt = input.prompt ?? '';

    if (input.run_in_background === true) {
      if (ctx.background === undefined) {
        return fail('当前上下文不支持后台任务。');
      }
      // 后台派生的语义是「脱离当前回合独立存活」，因此**不能**把 ctx.signal 直接传下去：
      // 那样父回合一结束或被 Esc 中断，signal abort 会连带杀死后台子 agent，
      // 「已在后台继续」的承诺当场失效（前台转后台路径靠 unbind() 切断父信号，此处等价处理）。
      // 独立 AbortController 只由 task_stop / 后台超时经 onStop 触发。
      // 派生前父信号已 abort 则不必开工——那是回合已经结束，没人会来取结果。
      if (ctx.signal?.aborted === true) {
        return fail('当前回合已中断，未派生后台子 agent。');
      }
      const bgCtrl = new AbortController();
      const run = ctx
        .runSubagent({
          subagentType,
          prompt,
          depth: ctx.depth ?? 0,
          signal: bgCtrl.signal,
          description: input.description,
          resume: input.resume,
          fork: input.fork,
          model: input.model,
          agentFile: input.agent_file,
        })
        .then((r) => ({
          output: formatSubagentResult(subagentType, r.isError ? 'error' : 'done', r.summary, r.sessionId, r.cause),
          ok: !r.isError,
        }));
      try {
        const id = ctx.background.startTask(
          `子agent·${input.description ?? '任务'}`,
          run,
          undefined,
          {
            kind: 'subagent',
            agentType: subagentType,
          },
          // async 任务无进程可杀，stop/超时经 onStop 传达中断（否则 task_stop 只改状态、任务照跑）
          { onStop: () => bgCtrl.abort() },
        );
        return ok(`已在后台派生子 agent（task_id=${id}）。用 task_output 查询结果。`);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    const result = await runForegroundSubagent(input, ctx, subagentType, prompt);
    // cause 透传给调度层：429 限流失败时父侧据此重排队尾（第二道防线）
    if (result.isError) {
      return {
        ...fail(formatSubagentResult(subagentType, 'error', result.summary, result.sessionId, result.cause)),
        cause: result.cause,
      };
    }
    return ok(formatSubagentResult(subagentType, 'done', result.summary, result.sessionId));
  },
};

/**
 * 前台子 agent：上下文支持后台任务时启动即登记为前台任务，运行期间可被 Ctrl+B 转后台。
 * 中断通道独立化：子 agent 拿独立的 AbortController，父回合信号经 propagate 单向传入；
 * detach 后摘除 propagate，此后父回合 Esc 中断不再波及已转后台的子 agent（signal 解绑）。
 * 登记失败（并发上限）或上下文不支持后台任务时，退化为直接前台等待（信号原样透传）。
 */
async function runForegroundSubagent(
  input: {
    description?: string | undefined;
    resume?: string | undefined;
    fork?: string | undefined;
    model?: string | undefined;
    agent_file?: string | undefined;
  },
  ctx: ToolContext,
  subagentType: string,
  prompt: string,
): Promise<SubagentResult> {
  const background = ctx.background;
  if (background === undefined) {
    return ctx.runSubagent!({
      subagentType,
      prompt,
      depth: ctx.depth ?? 0,
      signal: ctx.signal,
      description: input.description,
      resume: input.resume,
      fork: input.fork,
      model: input.model,
      agentFile: input.agent_file,
    });
  }

  const subCtrl = new AbortController();
  const propagate = (): void => subCtrl.abort();
  if (ctx.signal !== undefined) {
    if (ctx.signal.aborted) subCtrl.abort();
    else ctx.signal.addEventListener('abort', propagate, { once: true });
  }
  const unbind = (): void => ctx.signal?.removeEventListener('abort', propagate);

  type Tracked = { result: SubagentResult; output: string; ok: boolean };
  const tracked: Promise<Tracked> = ctx
    .runSubagent!({
      subagentType,
      prompt,
      depth: ctx.depth ?? 0,
      signal: subCtrl.signal,
      description: input.description,
      resume: input.resume,
      fork: input.fork,
      model: input.model,
      agentFile: input.agent_file,
    })
    .then((result) => ({
      result,
      output:
        result.sessionId !== undefined ? `${result.summary}\n（子会话 id：${result.sessionId}）` : result.summary,
      ok: !result.isError,
    }));
  // 运行结束（无论哪条路径）即解除父信号监听，避免监听器挂到后续回合
  void tracked.then(unbind, unbind);

  let taskId: string | undefined;
  try {
    taskId = background.startForegroundTask(
      `子agent·${input.description ?? '任务'}`,
      tracked,
      { kind: 'subagent', agentType: subagentType },
      { onStop: () => subCtrl.abort() },
    );
  } catch {
    taskId = undefined; // 并发上限：退化为不可转后台的前台等待（propagate 仍在，Esc 照常中断）
  }

  if (taskId !== undefined) {
    const released = await Promise.race([
      tracked.then(() => 'finished' as const),
      background.waitForegroundRelease(taskId),
    ]);
    if (released !== 'finished' && released !== 'terminal') {
      // 已转后台：切断父中断通道，工具正常结算；子 agent 继续跑，
      // 终态结果经后台通知链路（drainSettled）回灌会话
      unbind();
      return {
        summary: `子 agent 已转为后台任务 ${taskId} 继续运行，不再阻塞当前回合。任务到达终态时你会收到完成通知；也可用 task_list 查看状态、task_output 看输出、task_stop 终止。`,
        isError: false,
      };
    }
  }
  return (await tracked).result;
}
