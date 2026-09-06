import { z } from 'zod';
import { fail, ok, type ToolDef } from './types.js';
import { extractText } from './subagentControl.js';

/**
 * read_history：主 agent 读自己当前会话的历史。
 *
 * 定位：上下文压缩后恢复、长任务 resume 续跑时找回「之前做到哪」。不是随时翻旧账。
 * 数据源是 SessionStore.resume() 重放后的存活序列——它已重放 apply_compaction 的整体替换，
 * 与模型当前上下文一致，不混被摘要替代的原始历史。压缩摘要本身是存活序列开头一条
 * origin.kind === 'compaction_summary' 的 user 消息，直接识别作概览。
 *
 * 防爆三层：① limit 上限 50 + extractText 摘要化（与 subagent_trace 同一套）；
 * ② 单次返回固定有界，不随历史总长增长；③ before_compaction 默认关闭，开启时强截断
 * 并显式标注「已被摘要替代，可能与概览矛盾」。
 */
const PREVIEW_CHARS = 500;
const BEFORE_COMPACTION_LIMIT = 15;

const readHistorySchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('返回最近 N 条存活消息，默认 20，上限 50。防止上下文爆炸。'),
  role: z
    .enum(['user', 'assistant', 'tool'])
    .optional()
    .describe('只返回指定角色的消息。留空返回全部。压缩概览不受此过滤影响。'),
  include_compaction: z
    .boolean()
    .optional()
    .describe('是否附上宿主压缩摘要作概览（会话压过时）。默认 true。'),
  before_compaction: z
    .boolean()
    .optional()
    .describe(
      '是否深挖最近一次压缩点之前的原始历史。默认 false。这些已被摘要替代、可能与概览矛盾；' +
        '开启时强截断（上限 ' + BEFORE_COMPACTION_LIMIT + ' 条）并显式标注。',
    ),
});

function previewText(content: unknown): string {
  // extractText 接受 Anthropic.MessageParam['content']（string 或 block 数组），这里复用它做摘要化。
  const text = extractText(content as never).trim();
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '...' : text;
}

export const readHistoryTool: ToolDef<z.infer<typeof readHistorySchema>> = {
  name: 'read_history',
  description:
    '读取当前会话的历史消息，用于上下文压缩后找回关键上下文、或长任务续跑时确认「之前做到哪」。' +
    '默认返回最近的存活消息（与你当前上下文一致，压缩点之前已被摘要的原始内容不混入），' +
    '并在会话压过时附上压缩摘要概览。需要定位最近压缩点之前的原始记录时显式开 before_compaction。',
  schema: readHistorySchema,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (ctx.sessionStore === undefined) return fail('当前上下文不支持会话存储。');
    if (ctx.sessionId === undefined) return fail('当前上下文缺少会话 id。');
    // 主 agent 自助读自己历史的能力：子 agent（depth > 0）读主会话/别的会话历史属审查协作场景，
    // 归 subagent_trace 与后续设计，本期不在此工具开放。
    if ((ctx.depth ?? 0) > 0) return fail('read_history 仅主 agent 可用。子 agent 查看历史用 subagent_trace。');

    // resume 重放：返回 apply_compaction 替换后的存活序列，与模型真实上下文一致。
    const resumed = ctx.sessionStore.resume(ctx.cwd, ctx.sessionId);
    if (resumed === null) return fail('当前会话无历史记录。');
    const live = resumed.session.messages;

    // 压缩摘要：存活序列开头 origin.kind === 'compaction_summary' 的 user 消息。
    const compactionIdx = live.findIndex((m) => m.origin.kind === 'compaction_summary');
    const compactionMsg = compactionIdx >= 0 ? live[compactionIdx] : undefined;

    // 存活消息 = 压缩摘要之后的消息（摘要单独作概览，不混进消息列表）。
    let liveMsgs = compactionIdx >= 0 ? live.slice(compactionIdx + 1) : live;
    if (input.role !== undefined) {
      liveMsgs = liveMsgs.filter((m) => m.message.role === input.role);
    }
    const limit = input.limit ?? 20;
    const shown = liveMsgs.slice(-limit);

    const sections: string[] = [];

    // ① 压缩概览
    const includeCompaction = input.include_compaction !== false;
    if (includeCompaction && compactionMsg !== undefined) {
      sections.push(
        '【压缩概览】以下是最近一次上下文压缩时保留的关键摘要（更早的细节已被压缩，需要原始记录见文末深挖）：\n' +
          previewText(compactionMsg.message.content),
      );
    }

    // ② 存活消息
    if (shown.length === 0) {
      sections.push(`（没有符合条件的存活消息${input.role !== undefined ? `（角色 ${input.role}）` : ''}。）`);
    } else {
      const header = `【最近消息】存活消息共 ${liveMsgs.length} 条${
        input.role !== undefined ? `（已按角色 ${input.role} 过滤）` : ''
      }，显示最近 ${shown.length} 条：`;
      const lines = shown.map((m, i) => {
        const role = m.message.role;
        return `[${i + 1}] ${role}: ${previewText(m.message.content)}`;
      });
      sections.push(header + '\n' + lines.join('\n\n'));
    }

    // ③ before_compaction：压缩点之前的原始历史（opt-in，强截断 + 警告）
    if (input.before_compaction) {
      if (compactionIdx < 0 && compactionMsg === undefined) {
        sections.push('【压缩前原始历史】本会话未发生过压缩，无压缩点之前的原始记录。');
      } else {
        // 压缩点之前的原始 append_message：从 wire 事件流取，最后一个 apply_compaction 之前的消息。
        const events = ctx.sessionStore.loadWire(ctx.cwd, ctx.sessionId);
        let lastCompactionEventIdx = -1;
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].type === 'context.apply_compaction') {
            lastCompactionEventIdx = i;
            break;
          }
        }
        const beforeMsgs =
          lastCompactionEventIdx >= 0
            ? events
                .slice(0, lastCompactionEventIdx)
                .filter((e): e is Extract<(typeof events)[number], { type: 'context.append_message' }> => e.type === 'context.append_message')
                .map((e) => e.message)
            : [];
        const filtered =
          input.role !== undefined ? beforeMsgs.filter((m) => m.message.role === input.role) : beforeMsgs;
        const beforeShown = filtered.slice(-BEFORE_COMPACTION_LIMIT);
        sections.push(
          '【压缩前原始历史 · 警告】以下记录已被压缩摘要替代，可能与概览矛盾（含被推翻的尝试），仅作回溯参考，' +
            `不要据此判断当前状态。压缩点前原始消息共 ${filtered.length} 条，强截断显示最近 ${beforeShown.length} 条：\n` +
            (beforeShown.length === 0
              ? '（无符合条件的记录。）'
              : beforeShown
                  .map((m, i) => `[${i + 1}] ${m.message.role}: ${previewText(m.message.content)}`)
                  .join('\n\n')),
        );
      }
    }

    return ok(sections.join('\n\n'));
  },
};
