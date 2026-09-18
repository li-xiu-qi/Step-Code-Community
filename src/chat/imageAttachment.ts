import type Anthropic from '@anthropic-ai/sdk';

/**
 * 输入框图片附件登记表 + 占位符提取。
 *
 * 贴图（Alt+V）时把图片存进 store 并分配自增 id，同时往输入框光标处插入一个可见的
 * 占位符文本 `[image #1 (1920×1080)]`。用户能直接看到它、像删普通文字一样删掉它
 * （删占位符 = 移除该图）。提交时 extractImageContent 扫描文本，把仍存在的占位符展开
 * 成 Anthropic image content block，删掉的占位符自然不发。
 *
 * 占位符是固定英文格式的机器标记，不随界面语言变化，便于稳定正则匹配。
 * 作用域为单次会话：/new、/resume、会话切换时 clear()，id 重新从 1 开始。
 */

export interface ImageAttachment {
  readonly id: number;
  readonly base64: string;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  /** 渲染出的占位符文本，如 `[image #1 (1920×1080)]`。 */
  readonly placeholder: string;
  /**
   * 粘贴即落盘的附件绝对路径（sessions/<workdirKey>/attachments/<sha256>.<ext>）。
   * 粘贴时同步 offload 得到；小图（<OFFLOAD_THRESHOLD，内联不落盘）或落盘失败时为
   * undefined。提交时把它写进模型侧文本（Attached image file: ...），模型据此可直接
   * read_media 重读，不用翻磁盘猜路径。见 2026-09-13 贴图持久化设计。
   */
  readonly path?: string;
}

/** 匹配输入框里的图片占位符，捕获 id。宽高用非贪婪匹配，兼容用户手打的近似格式。 */
const PLACEHOLDER_RE = /\[image #(\d+) \(\d+×\d+\)\]/g;

export function formatPlaceholder(id: number, width: number, height: number): string {
  return `[image #${id} (${width}×${height})]`;
}

export class ImageAttachmentStore {
  private nextId = 1;
  private readonly byId = new Map<number, ImageAttachment>();

  add(base64: string, mediaType: string, width: number, height: number, path?: string): ImageAttachment {
    const id = this.nextId;
    this.nextId += 1;
    const att: ImageAttachment = {
      id,
      base64,
      mediaType,
      width,
      height,
      placeholder: formatPlaceholder(id, width, height),
      ...(path !== undefined ? { path } : {}),
    };
    this.byId.set(id, att);
    return att;
  }

  get(id: number): ImageAttachment | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.byId.clear();
    this.nextId = 1;
  }

  size(): number {
    return this.byId.size;
  }

  /** 扫描文本，返回其中仍存在（能在 store 里查到）的占位符对应的图片 id，按出现顺序去重。 */
  activeIds(text: string): number[] {
    const ids: number[] = [];
    const seen = new Set<number>();
    PLACEHOLDER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
      const id = Number.parseInt(m[1]!, 10);
      if (!seen.has(id) && this.byId.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }
}

const SUPPORTED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function toImageBlock(att: ImageAttachment): Anthropic.ImageBlockParam {
  const mediaType = SUPPORTED_MEDIA.has(att.mediaType) ? att.mediaType : 'image/png';
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      data: att.base64,
    },
  };
}

export interface ExtractResult {
  /** 发给 provider 的 message content：纯文本时是字符串，含图片时是块数组。 */
  content: Anthropic.MessageParam['content'];
  /** 命中的图片数量（0 表示纯文本）。 */
  imageCount: number;
  /** 展示给转录区的用户文本：占位符已折叠掉，保留正文。 */
  displayText: string;
}

/**
 * 提交时把输入文本里的图片占位符展开为 image content block。
 * 占位符前后的文本按顺序保留为 text block；相邻空白段丢弃避免噪声。
 * 没有命中任何占位符时返回纯文本字符串（保持旧路径）。
 */
export function extractImageContent(text: string, store: ImageAttachmentStore): ExtractResult {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const displayParts: string[] = [];
  let cursor = 0;
  let imageCount = 0;

  const pushText = (seg: string): void => {
    if (seg === '' || seg.trim() === '') return;
    const last = blocks.at(-1);
    if (last?.type === 'text') {
      (last as Anthropic.TextBlockParam).text += seg;
    } else {
      blocks.push({ type: 'text', text: seg });
    }
    displayParts.push(seg);
  };

  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    const id = Number.parseInt(m[1]!, 10);
    const att = store.get(id);
    if (att === undefined) continue; // 陈旧或用户手打的占位符：留作文本，不展开
    pushText(text.slice(cursor, m.index));
    blocks.push(toImageBlock(att));
    imageCount += 1;
    cursor = m.index + m[0].length;
  }
  pushText(text.slice(cursor));

  if (imageCount === 0) {
    return { content: text, imageCount: 0, displayText: text };
  }
  return {
    content: blocks,
    imageCount,
    displayText: displayParts.join('').trim(),
  };
}

/** 模型侧贴图路径标记的行前缀。历史回放据此过滤机器标记（不进用户可见文本）。 */
const IMAGE_PATH_MARKER_PREFIX = 'Attached image file:';

/**
 * 组装模型侧的贴图路径文本块：每个落盘路径一行，固定英文机器标记（不随界面语言
 * 变化，与占位符同族，便于模型稳定识别）。无路径时返回 undefined，调用方不追加。
 *
 * 用途：提交时把粘贴即落盘的附件路径附在消息尾部，模型据此可直接 read_media
 * 重读，不用翻磁盘猜路径（2026-09-13 会话实测：没有路径时模型搜了六轮目录）。
 *
 * 只读语义是契约的一部分：附件文件在会话自有目录里，会话存储持 stepref 指针引用它，
 * 模型移动或删除会让 resume 后 rehydrate 失败、该图变成 [image missing]。需要
 * 副本时让模型 copy 而非 move。
 */
export function formatImagePathText(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  return paths.map((p) => `${IMAGE_PATH_MARKER_PREFIX} ${p} (read-only session file; open it with read_media)`).join('\n');
}

/** 判断一段文本是否整段都是贴图路径机器标记（供历史回放过滤，匹配本模块产出的格式）。 */
export function isImagePathMarker(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return lines.length > 0 && lines.every((l) => l.startsWith(IMAGE_PATH_MARKER_PREFIX));
}

/**
 * 统计历史中的图片块数（顶层 image 块 + tool_result 内嵌图）。
 *
 * 用途：切到显式声明不收图（capabilities 含 `-image_in`）的模型时，据此提示
 * 「历史里这 N 张图会以占位文本投影」。原图仍在会话里，切回多模态模型即恢复——
 * 投影发生在发送前的包装层（`withCapabilityProjection`），不改写历史。
 */
export function countHistoryImages(messages: readonly { message: { content: unknown } }[]): number {
  let n = 0;
  for (const sm of messages) {
    const c = sm.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c as { type?: string; content?: unknown }[]) {
      if (b.type === 'image') n++;
      else if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (const inner of b.content as { type?: string }[]) if (inner.type === 'image') n++;
      }
    }
  }
  return n;
}
