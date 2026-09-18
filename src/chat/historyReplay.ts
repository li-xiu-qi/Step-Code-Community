import type Anthropic from '@anthropic-ai/sdk';
import { isSystemAuthoredUser, type MessageOrigin, type StoredMessage } from '../agent/message.js';
import { sliceRecentTurns } from '../agent/turns.js';
import { isStepref } from '../session/attachments.js';
import { parseImageMeta } from '../tools/imageMeta.js';
import { t } from '../i18n.js';
import { isImagePathMarker, type ImageAttachment } from './imageAttachment.js';
import type { DisplayItem } from './types.js';
import type { ToolResultImage } from '../tools/types.js';

/**
 * 会话回放：把恢复的历史消息（StoredMessage[]）投影成可渲染的 DisplayItem[]。
 *
 * 适配 Step Code 的数据驱动 UI：DisplayItem 是静态数据结构，
 * 故直接构造与实时 applyEvent 结构一致的 DisplayItem，无需模拟流式管线。
 * 产物走同一个 MessageItem 组件渲染，保证回放与实时逐像素一致。
 *
 * 关键处理：
 * - assistant 的 text 块拼成一条 assistant，thinking 块落成 thinking，tool_use 落成 tool；
 * - tool_result 按 tool_use_id 配对回填到对应 tool 的 result/status（Map 配对），
 *   内嵌图片经解析器还原后挂 resultImages（与实时 read_media 结果同渲染路径）；
 * - 非真人输入的 user 角色消息不渲染成用户气泡（见 isSystemAuthoredUser）；
 * - 用户消息的图片块经解析器从 stepref 还原成真图挂 images 字段（与实时贴图回显同形），
 *   解析失败（附件缺失/无解析器）回退 [图片] 占位文本；
 * - 模型侧的贴图路径机器标记（Attached image file: ...）过滤出用户可见文本；
 * - 按轮次截断（sliceRecentTurns），避免长会话一次性刷屏。
 */

/** 回放默认保留的最近轮数（一轮 = 一次真人输入到下次输入前）。超出的折叠。 */
export const REPLAY_TURN_LIMIT = 15;

/**
 * 回放图片解析器：把存储态 stepref 指针还原成 base64。
 * 缺省不传（无附件上下文的调用，如单测）时图片一律回退 [图片] 占位。
 */
export interface ReplayImageResolver {
  rehydrate(stepref: string): string | null;
}

/** 图片块 → 回放用附件：stepref 经解析器还原、字节解析宽高；任何一步失败返回 null。 */
function replayImageAttachment(
  block: Anthropic.ImageBlockParam,
  resolver: ReplayImageResolver | undefined,
): ImageAttachment | null {
  const source = block.source;
  if (source.type !== 'base64') return null;
  let base64 = source.data;
  if (isStepref(base64)) {
    if (resolver === undefined) return null;
    const rehydrated = resolver.rehydrate(base64);
    if (rehydrated === null) return null;
    base64 = rehydrated;
  }
  const meta = parseImageMeta(Buffer.from(base64, 'base64'));
  if (meta === null) return null;
  return {
    id: 0,
    base64,
    mediaType: source.media_type,
    width: meta.width,
    height: meta.height,
    placeholder: '',
  };
}

/** tool_result 的 content（string 或块数组）→ 展示文本 + 可还原的内嵌图片。 */
function toolResultContent(
  content: Anthropic.ToolResultBlockParam['content'],
  resolver: ReplayImageResolver | undefined,
): { text: string; images: ToolResultImage[] } {
  if (content === undefined) return { text: '', images: [] };
  if (typeof content === 'string') return { text: content, images: [] };
  let text = '';
  const images: ToolResultImage[] = [];
  for (const b of content) {
    if (b.type === 'text') text += b.text;
    else if (b.type === 'image') {
      const att = replayImageAttachment(b, resolver);
      if (att !== null) images.push({ mediaType: att.mediaType, base64: att.base64 });
      else text += '[图片]';
    }
  }
  return { text, images };
}

type ToolItem = Extract<DisplayItem, { kind: 'tool' }>;

/**
 * 后台任务通知在回放时的 note 文案。
 * 原始消息正文是给模型看的 XML 信封（`<notification>…`），不适合直接摆给用户，
 * 故按 origin 里的结构化字段重新组织成一行人读的提示。
 */
function replayBackgroundNote(origin: MessageOrigin): string {
  const id = origin.taskId ?? '?';
  return t('historyReplay.backgroundSettled', { id });
}

export interface ReplayResult {
  items: DisplayItem[];
  totalTurns: number;
  foldedTurns: number;
}

/**
 * 组装 resume 完成后的完整 items：折叠提示（若有）置顶，回放历史居中，
 * 恢复 note 与尾随提示 note（goal 暂停、后台任务补投等）贴底。
 * 抽成纯函数的原因：调用方（App.resumeSessionById）用 setItems 整体替换 items，
 * 中途 pushItem 的 note 会被覆盖丢失，必须先收集再一次性拼装（2026-08-15 修复）。
 */
export function assembleResumeItems(
  replay: ReplayResult,
  resumedNote: DisplayItem,
  tailNotes: DisplayItem[] = [],
): DisplayItem[] {
  const head: DisplayItem[] =
    replay.foldedTurns > 0
      ? [
          {
            kind: 'note',
            text: t('app.replay.folded', { folded: replay.foldedTurns, total: replay.totalTurns }),
          },
        ]
      : [];
  return [...head, ...replay.items, resumedNote, ...tailNotes];
}

/**
 * 把历史消息转成 DisplayItem 列表。
 * keepTurns 控制回放的最近轮数；<=0 表示全量。
 * images 为图片解析器（stepref → base64）；不传时图片块回退 [图片] 占位文本。
 */
export function historyToDisplayItems(
  messages: StoredMessage[],
  keepTurns = REPLAY_TURN_LIMIT,
  images?: ReplayImageResolver,
): ReplayResult {
  const sliced = sliceRecentTurns(messages, keepTurns);
  const items: DisplayItem[] = [];
  // tool_use_id → 对应的 tool DisplayItem，供后续 tool_result 回填。
  const toolById = new Map<string, ToolItem>();
  let turnNum = 0; // 用户消息轮次计数（仅非系统自撰 user 计一轮）

  for (const stored of sliced.messages) {
    const { message, origin } = stored;

    // 系统自撰的 user 角色消息（中断提示、后台通知、压缩摘要等）不渲染成用户气泡——
    // 那是系统冒充用户说话。但**不能在此整条 continue**：tool origin 的消息虽也属系统自撰，
    // 其 tool_result 块要回填到对应 tool 条目（跳过会让工具结果全部丢失）。
    // 故这里只处理「有独立展示形式」的类型，其余交由下方按块分派，在生成用户气泡处再行拦截。
    const systemAuthored = message.role === 'user' && isSystemAuthoredUser(origin);
    if (systemAuthored) {
      if (origin.kind === 'background_task') {
        // 后台任务终态对用户有意义，降级为 note 条目保留可见性（正文是给模型看的 XML 信封，不外泄）。
        items.push({ kind: 'note', text: replayBackgroundNote(origin) });
        continue;
      }
      if (origin.kind === 'compaction_summary') {
        // 投影真正的交接摘要正文，而非一句泛泛提示。压缩把旧 assistant 回复摘要进这条消息，
        // resume 后若只显示「已压缩」，用户会看到满屏自己早先的消息却无模型回复、误以为输出丢失
        // （2026-08-19 实证：16 次压缩的会话 resume 后 131 条 user_verbatim 连排，旧 assistant
        // 全在摘要里）。把摘要摆出来才解释得清中间那段发生了什么。空摘要才回退通用提示。
        const summary = typeof message.content === 'string' ? message.content : '';
        items.push({
          kind: 'note',
          text: summary.trim() !== '' ? summary : t('historyReplay.compactedNote'),
        });
        continue;
      }
    }

    const { role, content } = message;

    // content 为纯字符串：user 直接成条，assistant 直接成条。
    if (typeof content === 'string') {
      if (content.trim() === '') continue;
      // 其余系统自撰纯文本（system-reminder 等）无独立展示形态，整条略过。
      if (systemAuthored) continue;
      if (role === 'user') {
        items.push(
          origin.kind === 'user_verbatim'
            ? { kind: 'user', text: content, verbatim: true, turnNum: ++turnNum }
            : { kind: 'user', text: content, turnNum: ++turnNum },
        );
      } else {
        items.push({ kind: 'assistant', text: content });
      }
      continue;
    }

    // content 为块数组：按块类型分派。
    if (role === 'assistant') {
      // 按块原始顺序构造，保持与实时渲染一致（文字通常先于 tool_use 出现）。
      // 相邻的 text 块合并成一条 assistant，遇到 thinking/tool_use 则先 flush 已累积的文字。
      let textBuf = '';
      const flushText = (): void => {
        if (textBuf.trim() !== '') items.push({ kind: 'assistant', text: textBuf });
        textBuf = '';
      };
      for (const block of content) {
        switch (block.type) {
          case 'text':
            textBuf += block.text;
            break;
          case 'thinking':
            flushText();
            if (block.thinking.trim() !== '') {
              items.push({ kind: 'thinking', text: block.thinking });
            }
            break;
          case 'tool_use': {
            flushText();
            const tool: ToolItem = {
              kind: 'tool',
              id: block.id,
              name: block.name,
              input: block.input,
              status: 'ok',
            };
            items.push(tool);
            toolById.set(block.id, tool);
            break;
          }
          default:
            break;
        }
      }
      flushText();
      continue;
    }

    // role === 'user'：同一消息的 text/image 块缓冲成一个用户条目（与实时回显同形：
    // 正文 + [N 张图] 标签 + images 字段），tool_result 块即时回填到 tool 条目。
    let bufText: string[] = [];
    let bufImages: ImageAttachment[] = [];
    const flushUserItem = (): void => {
      if (bufText.length === 0 && bufImages.length === 0) return;
      const body = bufText.join('').trim();
      const text = bufImages.length > 0 ? `${body} [${bufImages.length} 张图]` : body;
      if (text.trim() !== '') {
        items.push(
          origin.kind === 'user_verbatim'
            ? { kind: 'user', text, verbatim: true, turnNum: ++turnNum, ...(bufImages.length > 0 ? { images: bufImages } : {}) }
            : { kind: 'user', text, turnNum: ++turnNum, ...(bufImages.length > 0 ? { images: bufImages } : {}) },
        );
      }
      bufText = [];
      bufImages = [];
    };
    for (const block of content) {
      if (block.type === 'tool_result') {
        // 回填到对应的 tool 条目（含内嵌图片的还原）。
        flushUserItem();
        const tool = toolById.get(block.tool_use_id);
        if (tool !== undefined) {
          const { text, images: resultImages } = toolResultContent(block.content, images);
          tool.result = text;
          tool.status = block.is_error === true ? 'error' : 'ok';
          if (resultImages.length > 0) tool.resultImages = resultImages;
        }
      } else if (block.type === 'text') {
        // 系统自撰消息里夹带的文本块不成用户气泡（如 tool origin 消息里的补充说明）。
        // 模型侧的贴图路径机器标记是发给模型的元数据，同样不进用户可见文本。
        if (!systemAuthored && !isImagePathMarker(block.text) && block.text.trim() !== '') {
          bufText.push(block.text);
        }
      } else if (block.type === 'image') {
        if (!systemAuthored) {
          const att = replayImageAttachment(block, images);
          if (att !== null) bufImages.push(att);
          else bufText.push(' [图片]'); // 附件缺失或无解析器：回退占位文本（前导空格分隔前文）
        }
      }
    }
    flushUserItem();
  }

  return { items, totalTurns: sliced.totalTurns, foldedTurns: sliced.foldedTurns };
}
