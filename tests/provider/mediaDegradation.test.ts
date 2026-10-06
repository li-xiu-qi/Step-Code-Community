import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { withMediaDegradation } from '../../src/provider/mediaDegradation.js';
import type { ChatProvider } from '../../src/provider/types.js';

/**
 * withMediaDegradation 的通道无关降级重试：mock 一个 ChatProvider，
 * 验证 stream 的 finalMessage 遇媒体超限错误时沿降级链重发、非媒体错误直接抛。
 */

const imageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
} as unknown as Anthropic.ImageBlockParam;

const okMessage = { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } as unknown as Anthropic.Message;

/** 记录每次 stream 收到的 messages，按脚本逐个抛错/成功。 */
class MockProvider implements ChatProvider {
  readonly name = 'mock';
  calls: Anthropic.MessageParam[][] = [];
  private script: (Error | 'ok')[];

  constructor(script: (Error | 'ok')[]) {
    this.script = [...script];
  }

  stream(params: { messages: Anthropic.MessageParam[] }): ReturnType<ChatProvider['stream']> {
    this.calls.push(params.messages);
    const action = this.script.shift() ?? 'ok';
    const handle = {
      async finalMessage(): Promise<Anthropic.Message> {
        if (action instanceof Error) throw action;
        return okMessage;
      },
    };
    return handle as unknown as ReturnType<ChatProvider['stream']>;
  }
}

const mediaErr = () =>
  new Anthropic.APIError(400, undefined, 'Input images too many. max: 60, input: 61', undefined);

const history: Anthropic.MessageParam[] = [{ role: 'user', content: [imageBlock] }];

describe('withMediaDegradation', () => {
  it('无错误时透传，只调一次 stream', async () => {
    const inner = new MockProvider(['ok']);
    const p = withMediaDegradation(inner);
    const msg = await p.stream({ system: 's', tools: [], messages: history }).finalMessage();
    expect(msg.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(inner.calls).toHaveLength(1);
    expect(JSON.stringify(inner.calls[0])).toContain('base64');
  });

  it('媒体超限 400 后降级重发：第二次图片换占位（保留语义文案）', async () => {
    const inner = new MockProvider([mediaErr(), 'ok']);
    const p = withMediaDegradation(inner);
    const msg = await p.stream({ system: 's', tools: [], messages: history }).finalMessage();
    expect(msg.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(inner.calls).toHaveLength(2);
    expect(JSON.stringify(inner.calls[0])).toContain('base64');
    // keep=0（这里用默认 10 但只 1 张图，media-degraded 保留它 → 仍含 base64）；
    // 为验证占位文案，用 keepRecentImages: 0 强制全换占位
    const inner2 = new MockProvider([mediaErr(), 'ok']);
    const p2 = withMediaDegradation(inner2, { keepRecentImages: 0 });
    await p2.stream({ system: 's', tools: [], messages: history }).finalMessage();
    expect(JSON.stringify(inner2.calls[1])).toContain('[image removed: exceeded API image limit');
    expect(JSON.stringify(inner2.calls[1])).not.toContain('base64');
  });

  it('keepRecentImages 保留最近 N 张：旧图换占位、新图保留', async () => {
    const imgOld = { ...imageBlock, source: { type: 'base64', media_type: 'image/png', data: 'b2xk' } } as unknown as Anthropic.ImageBlockParam;
    const imgNew = { ...imageBlock, source: { type: 'base64', media_type: 'image/png', data: 'bmV3' } } as unknown as Anthropic.ImageBlockParam;
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: [imgOld] },
      { role: 'user', content: [imgNew] },
    ];
    const inner = new MockProvider([mediaErr(), 'ok']);
    const p = withMediaDegradation(inner, { keepRecentImages: 1 });
    await p.stream({ system: 's', tools: [], messages: msgs }).finalMessage();
    const second = JSON.stringify(inner.calls[1]);
    // 旧图（b2xk = 'old'）被换占位，新图（bmV3 = 'new'）保留
    expect(second).toContain('[image removed');
    expect(second).toContain('bmV3');
    expect(second).not.toContain('b2xk');
  });

  it('逐档推进直到档位用尽，抛出最后一次错误', async () => {
    const inner = new MockProvider([mediaErr(), mediaErr(), mediaErr(), mediaErr()]);
    const p = withMediaDegradation(inner);
    await expect(p.stream({ system: 's', tools: [], messages: history }).finalMessage()).rejects.toThrow(/too many/);
    // normal + media-degraded + media-stripped + strict 共 4 次
    expect(inner.calls).toHaveLength(4);
    // strict 档：媒体块整个移除
    expect(JSON.stringify(inner.calls[3])).not.toContain('base64');
    expect(JSON.stringify(inner.calls[3])).not.toContain('image removed');
  });

  it('非媒体错误（500 / 裸 400 参数错 / 上下文溢出）不重试，直接抛', async () => {
    for (const err of [
      new Anthropic.APIError(500, undefined, 'boom', undefined),
      new Anthropic.APIError(400, undefined, 'invalid_request_error: max_tokens must be positive', undefined),
      new Anthropic.APIError(400, undefined, 'prompt is too long', undefined),
    ]) {
      const inner = new MockProvider([err]);
      const p = withMediaDegradation(inner);
      await expect(p.stream({ system: 's', tools: [], messages: history }).finalMessage()).rejects.toThrow();
      expect(inner.calls).toHaveLength(1);
    }
  });

  it('413 载荷过大不看文案直接降级', async () => {
    const inner = new MockProvider([new Anthropic.APIError(413, undefined, 'whatever', undefined), 'ok']);
    const p = withMediaDegradation(inner, { keepRecentImages: 0 });
    await p.stream({ system: 's', tools: [], messages: history }).finalMessage();
    expect(inner.calls).toHaveLength(2);
    expect(JSON.stringify(inner.calls[1])).toContain('[image removed');
  });

  it('默认 keepRecentImages 为 10（未传 options 时）', async () => {
    // 11 张图，默认 keep=10 → 最旧 1 张换占位，其余 10 张保留
    const imgs = Array.from({ length: 11 }, (_, i) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: `aW1n${i}` }, // imgN
    })) as unknown as Anthropic.ImageBlockParam[];
    const msgs: Anthropic.MessageParam[] = [{ role: 'user', content: imgs }];
    const inner = new MockProvider([mediaErr(), 'ok']);
    const p = withMediaDegradation(inner); // 不传 options → 默认 10
    await p.stream({ system: 's', tools: [], messages: msgs }).finalMessage();
    const second = JSON.stringify(inner.calls[1]);
    // 最旧的 img0 被换占位，img1..img10 保留
    expect(second).toContain('[image removed');
    expect(second).not.toContain('aW1n0');
    expect(second).toContain('aW1n10');
  });
});

/**
 * 迭代期错误覆盖（2026-10-06 session c527ea 实证缺口）：
 * OpenAI 兼容通道的 fetch 在首个事件拉取时才发出，媒体 400 在迭代起点抛出，
 * 永远走不到 finalMessage——只拦 finalMessage 的 wrapper 全程不触发。
 */
class IterMockProvider implements ChatProvider {
  readonly name = 'iter-mock';
  calls: Anthropic.MessageParam[][] = [];
  constructor(private behavior: 'throw-first' | 'throw-after-event') {}
  stream(params: { messages: Anthropic.MessageParam[] }): ReturnType<ChatProvider['stream']> {
    this.calls.push(params.messages);
    const callNo = this.calls.length;
    const behavior = this.behavior;
    const handle = {
      async *iterate() {
        if (callNo === 1) {
          if (behavior === 'throw-first') {
            throw new Error('HTTP 400 · images_too_may: The amount of images you provided exceeds the model\'s limitation.');
          }
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } };
          throw new Error('HTTP 400 · images_too_may: The amount of images you provided exceeds the model\'s limitation.');
        }
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } };
      },
      async finalMessage(): Promise<Anthropic.Message> {
        return okMessage;
      },
    };
    return {
      finalMessage: handle.finalMessage,
      [Symbol.asyncIterator]: () => handle.iterate(),
    } as unknown as ReturnType<ChatProvider['stream']>;
  }
}

describe('withMediaDegradation 迭代期错误', () => {
  const imgMessages = [
    { role: 'user', content: [imageBlock, { type: 'text', text: '看图' }] },
  ] as unknown as Anthropic.MessageParam[];

  it('迭代起点抛媒体 400：换档重发且第二次调用图片已换占位', async () => {
    const p = new IterMockProvider('throw-first');
    // keepRecentImages: 0 强制全换占位（默认 keep=10 会保留这 1 张图，见 finalMessage 侧同构用例）
    const w = withMediaDegradation(p, { keepRecentImages: 0 });
    const events: string[] = [];
    for await (const ev of w.stream({ messages: imgMessages } as never)) {
      events.push(JSON.stringify(ev));
    }
    expect(p.calls).toHaveLength(2);
    expect(JSON.stringify(p.calls[1])).toContain('[image removed');
    expect(events.some((e) => e.includes('ok'))).toBe(true);
  });

  it('已吐出事件后抛媒体错误：不重试，错误原样抛出（防正文重复上屏）', async () => {
    const p = new IterMockProvider('throw-after-event');
    const w = withMediaDegradation(p);
    const events: string[] = [];
    await expect(async () => {
      for await (const ev of w.stream({ messages: imgMessages } as never)) {
        events.push(JSON.stringify(ev));
      }
    }).rejects.toThrow(/images_too_may/);
    expect(p.calls).toHaveLength(1); // 没有第二次调用
    expect(events.some((e) => e.includes('partial'))).toBe(true);
  });
});
