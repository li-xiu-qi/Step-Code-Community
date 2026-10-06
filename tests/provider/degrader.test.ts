import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  applyReprojectionLevel,
  degradeMessages,
  isReprojectableError,
  nextReprojectionLevel,
  type ReprojectionLevel,
} from '../../src/provider/degrader.js';

const CC = { type: 'ephemeral' };

const imageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'x' },
} as unknown as Anthropic.ImageBlockParam;

/** 视频块（read_media 视频支持引入的非官方块类型，运行时形状）。 */
const videoBlock = {
  type: 'video',
  source: { type: 'base64', media_type: 'video/mp4', data: 'v' },
} as unknown as Anthropic.ContentBlockParam;

const thinkingBlock = {
  type: 'thinking',
  thinking: '想',
  signature: 'sig',
} as unknown as Anthropic.ContentBlockParam;

/** 全支持能力：degrader 不应动任何东西。 */
const FULL_CAPABILITY = {
  image_in: true,
  video_in: true,
  reasoning: true,
  cache_control: true,
  tool_use: true,
  max_context_tokens: 0,
  max_output_tokens: 0,
};

describe('degradeMessages 主动降级', () => {
  it('image_in 为 false：图片块换成占位文本', () => {
    const out = degradeMessages(
      [{ role: 'user', content: [imageBlock, { type: 'text', text: '看图' }] }],
      { ...FULL_CAPABILITY, image_in: false },
    );
    const content = out[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({
      type: 'text',
      text: '[image omitted: model has no image input]',
    });
    expect(content[1]).toEqual({ type: 'text', text: '看图' });
  });

  it('cache_control 为 false：所有块的 cache_control 被剥离', () => {
    const out = degradeMessages(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi', cache_control: CC } as Anthropic.TextBlockParam],
        },
      ],
      { ...FULL_CAPABILITY, cache_control: false },
    );
    const block = (out[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(block['cache_control']).toBeUndefined();
    expect(block['text']).toBe('hi');
  });

  it('reasoning 为 false：thinking 块被剥掉', () => {
    const out = degradeMessages(
      [{ role: 'assistant', content: [thinkingBlock, { type: 'text', text: '答' }] }],
      { ...FULL_CAPABILITY, reasoning: false },
    );
    expect(out[0]!.content).toEqual([{ type: 'text', text: '答' }]);
  });

  it('能力全支持：消息原样不动', () => {
    const input: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [imageBlock, { type: 'text', text: 'hi', cache_control: CC } as Anthropic.TextBlockParam],
      },
    ];
    const out = degradeMessages(input, FULL_CAPABILITY);
    expect(out[0]!.content).toEqual(input[0]!.content);
  });

  it('全 false 能力：三类同时降级', () => {
    const out = degradeMessages([{ role: 'assistant', content: [thinkingBlock, imageBlock] }], {
      ...FULL_CAPABILITY,
      image_in: false,
      reasoning: false,
      cache_control: false,
      tool_use: false,
    });
    expect(out[0]!.content).toEqual([
      { type: 'text', text: '[image omitted: model has no image input]' },
    ]);
  });

  it('video_in 为 false：视频块换成占位文本（含 tool_result 内嵌视频）', () => {
    const videoBlock = {
      type: 'video',
      source: { type: 'base64', media_type: 'video/mp4', data: 'v' },
    } as unknown as Anthropic.ContentBlockParam;
    const inner: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text', text: '已读取视频' }, videoBlock],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
      { role: 'user', content: [videoBlock, { type: 'text', text: '看这个' }] },
    ];
    const out = degradeMessages(inner, { ...FULL_CAPABILITY, video_in: false });
    const tr = (out[0]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    const trContent = tr.content as Array<Record<string, unknown>>;
    expect(trContent[0]).toEqual({ type: 'text', text: '已读取视频' });
    expect(trContent[1]).toEqual({ type: 'text', text: '[video omitted: model has no video input]' });
    const top = out[1]!.content as Anthropic.ContentBlockParam[];
    expect(top[0]).toEqual({ type: 'text', text: '[video omitted: model has no video input]' });
  });

  it('image_in=false + video_in=true：视频块不被图片门控误伤（2026-09-14 回归钉）', () => {
    const out = degradeMessages(
      [{ role: 'user', content: [imageBlock, videoBlock, { type: 'text', text: '看图看视频' }] }],
      { ...FULL_CAPABILITY, image_in: false, video_in: true },
    );
    const content = out[0]!.content as Anthropic.ContentBlockParam[];
    // 图片被图片门控换占位；视频只受 video_in 门控（此处为 true），原样保留
    expect(content[0]).toEqual({ type: 'text', text: '[image omitted: model has no image input]' });
    expect(content[1]).toBe(videoBlock);
    expect(content[2]).toEqual({ type: 'text', text: '看图看视频' });
  });

  it('image_in 为 false：tool_result 内嵌图片同样换占位（下钻修复回归钉）', () => {
    const inner: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text', text: '已读取图片' }, imageBlock],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
    ];
    const out = degradeMessages(inner, { ...FULL_CAPABILITY, image_in: false });
    const tr = (out[0]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    const trContent = tr.content as Array<Record<string, unknown>>;
    expect(trContent[1]).toEqual({ type: 'text', text: '[image omitted: model has no image input]' });
  });
});

describe('applyReprojectionLevel 档位行为', () => {
  const history: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [imageBlock, { type: 'text', text: 'hi', cache_control: CC } as Anthropic.TextBlockParam],
    },
    { role: 'assistant', content: [thinkingBlock, { type: 'text', text: '答' }] },
  ];

  it('normal：原样返回', () => {
    expect(applyReprojectionLevel(history, 'normal')).toEqual(history);
  });

  it('media-degraded：媒体块换占位文本，其余不动', () => {
    const out = applyReprojectionLevel(history, 'media-degraded');
    const content = out[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({ type: 'text', text: '[image removed: exceeded API image limit, older images dropped to retry]' });
    expect(out[1]).toEqual(history[1]);
  });

  it('media-degraded 保留最近 N 张：旧图换占位、最近 N 张原样保留', () => {
    // 按消息逆序数：msg3 的 imgC/imgB、msg2 的 imgA 是最近 3 张之前的全部。
    // keep=2 时保留 imgC、imgB（msg3 内也按逆序，C 比 B 新），imgA 换占位。
    const imgA = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } } as unknown as Anthropic.ImageBlockParam;
    const imgB = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b' } } as unknown as Anthropic.ImageBlockParam;
    const imgC = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c' } } as unknown as Anthropic.ImageBlockParam;
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: [imgA, { type: 'text', text: '第一张' }] },
      { role: 'assistant', content: [{ type: 'text', text: '看到了' }] },
      { role: 'user', content: [imgB, imgC, { type: 'text', text: '再看这两张' }] },
    ];
    const out = applyReprojectionLevel(msgs, 'media-degraded', 2);
    // 最旧的 imgA 被换占位
    expect((out[0]!.content as Anthropic.ContentBlockParam[])[0]).toEqual({
      type: 'text',
      text: '[image removed: exceeded API image limit, older images dropped to retry]',
    });
    // 最近两张（imgB、imgC）原样保留
    const last = out[2]!.content as Anthropic.ContentBlockParam[];
    expect(last[0]).toBe(imgB);
    expect(last[1]).toBe(imgC);
    // 文本块与 assistant 消息不动
    expect(out[1]).toEqual(msgs[1]);
  });

  it('media-degraded keep=0 时维持旧行为（全部换占位）', () => {
    const out = applyReprojectionLevel(history, 'media-degraded', 0);
    const content = out[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({ type: 'text', text: '[image removed: exceeded API image limit, older images dropped to retry]' });
  });

  it('media-degraded：视频块换视频味占位（2026-09-14 事故回归钉：端点拒视频）', () => {
    // 2026-09-14 实录：某模型别名声明 video_in 但 openai 端点拒收（"The amount of
    // videos you provided exceeds the model's limitation"）。此前 video 不在
    // MEDIA_BLOCK_TYPES，任何档位都剥不掉，重发必再挂。本测试钉三件事：
    // 顶层与 tool_result 内嵌视频都被换占位、文案是视频味（不是图片味）、keep 计数只算图片。
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text', text: '已读取视频，原始字节 inline 交付' }, videoBlock],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
      { role: 'user', content: [imageBlock, videoBlock, { type: 'text', text: '看图看视频' }] },
    ];
    const out = applyReprojectionLevel(msgs, 'media-degraded', 3);
    const trContent = ((out[0]!.content as Anthropic.ToolResultBlockParam[])[0]!.content) as Array<Record<string, unknown>>;
    expect(trContent[0]).toEqual({ type: 'text', text: '已读取视频，原始字节 inline 交付' });
    expect(trContent[1]).toEqual({
      type: 'text',
      text: '[video removed: endpoint rejected video input, dropped to retry]',
    });
    const last = out[1]!.content as Anthropic.ContentBlockParam[];
    // 图片在保留集内（keep=3 只数图片，视频不参与计数），原样保留
    expect(last[0]).toBe(imageBlock);
    expect(last[1]).toEqual({
      type: 'text',
      text: '[video removed: endpoint rejected video input, dropped to retry]',
    });
    expect(last[2]).toEqual({ type: 'text', text: '看图看视频' });
  });

  it('media-stripped：视频块被整块移除', () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text', text: '已读取视频' }, videoBlock],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
      { role: 'user', content: [videoBlock, { type: 'text', text: '看视频' }] },
    ];
    const out = applyReprojectionLevel(msgs, 'media-stripped');
    const trContent = ((out[0]!.content as Anthropic.ToolResultBlockParam[])[0]!.content) as Array<Record<string, unknown>>;
    expect(trContent).toEqual([{ type: 'text', text: '已读取视频' }]);
    expect(out[1]!.content).toEqual([{ type: 'text', text: '看视频' }]);
  });

  it('media-stripped：tool_result 内嵌媒体同样被移除（下钻修复回归钉）', () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text', text: '已读取图片' }, imageBlock],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
    ];
    const out = applyReprojectionLevel(msgs, 'media-stripped');
    const tr = (out[0]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(tr.content).toEqual([{ type: 'text', text: '已读取图片' }]);
  });

  it('media-degraded 保留计数下钻 tool_result：内嵌的最近图不被误判为旧图剥掉', () => {
    const oldImg = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'old' } } as unknown as Anthropic.ImageBlockParam;
    const newImg = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'new' } } as unknown as Anthropic.ImageBlockParam;
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: [oldImg, { type: 'text', text: '旧图' }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text', text: '已读取图片' }, newImg],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
    ];
    const out = applyReprojectionLevel(msgs, 'media-degraded', 1);
    // 顶层旧图换占位；tool_result 内嵌的新图是最近 1 张，保留
    expect((out[0]!.content as Anthropic.ContentBlockParam[])[0]).toEqual({
      type: 'text',
      text: '[image removed: exceeded API image limit, older images dropped to retry]',
    });
    const tr = (out[1]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    const trContent = tr.content as Array<Record<string, unknown>>;
    expect(trContent[1]).toBe(newImg);
  });

  it('media-degraded 保留计数只算 image，document 块仍换占位', () => {
    const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'd' } } as unknown as Anthropic.ContentBlockParam;
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: [imageBlock] },
      { role: 'user', content: [doc] },
    ];
    const out = applyReprojectionLevel(msgs, 'media-degraded', 1);
    // image 是最近 1 张，保留；document 不参与计数，换占位
    expect((out[0]!.content as Anthropic.ContentBlockParam[])[0]).toBe(imageBlock);
    expect((out[1]!.content as Anthropic.ContentBlockParam[])[0]).toEqual({
      type: 'text',
      text: '[document omitted: model has no document input]',
    });
  });

  it('media-stripped：媒体块移除，thinking 与 cache_control 保留', () => {
    const out = applyReprojectionLevel(history, 'media-stripped');
    expect((out[0]!.content as unknown[]).length).toBe(1);
    expect(JSON.stringify(out)).toContain('thinking');
  });

  it('strict：媒体移除 + thinking 剥掉 + cache_control 剥掉', () => {
    const out = applyReprojectionLevel(history, 'strict');
    const first = out[0]!.content as Array<Record<string, unknown>>;
    expect(first).toHaveLength(1);
    expect(first[0]!['cache_control']).toBeUndefined();
    expect(out[1]!.content).toEqual([{ type: 'text', text: '答' }]);
  });
});

describe('nextReprojectionLevel 错误驱动档位', () => {
  // 真实媒体方言（stepfun 实测 2026-08-06 的报错文案）
  const err400 = () =>
    new Anthropic.APIError(400, undefined, 'Input images too many. model: step-3.7-flash, max: 60, input: 61', undefined);
  const err413 = () => new Anthropic.APIError(413, undefined, 'payload too large', undefined);

  it('413 / 媒体超限 400 可重投影，从 normal 进到 media-degraded', () => {
    const used = new Set<ReprojectionLevel>(['normal']);
    expect(nextReprojectionLevel(err413(), used)).toBe('media-degraded');
    expect(nextReprojectionLevel(err400(), used)).toBe('media-degraded');
  });

  it('逐档推进：media-degraded 用过后进 media-stripped，再到 strict', () => {
    const used = new Set<ReprojectionLevel>(['normal', 'media-degraded']);
    expect(nextReprojectionLevel(err400(), used)).toBe('media-stripped');
    used.add('media-stripped');
    expect(nextReprojectionLevel(err400(), used)).toBe('strict');
  });

  it('档位用尽返回 null', () => {
    const used = new Set<ReprojectionLevel>(REPROJECTION_LEVELS_ALL);
    expect(nextReprojectionLevel(err400(), used)).toBeNull();
  });

  it('上下文溢出的 400 不重投影（该走压缩历史）', () => {
    const overflow = new Anthropic.APIError(400, undefined, 'prompt is too long', undefined);
    expect(isReprojectableError(overflow)).toBe(false);
    expect(nextReprojectionLevel(overflow, new Set(['normal']))).toBeNull();
  });

  it('裸 400（非媒体方言）不重投影：参数错误不该被降级掩盖', () => {
    const plain = new Anthropic.APIError(400, undefined, 'invalid_request_error: max_tokens must be positive', undefined);
    expect(isReprojectableError(plain)).toBe(false);
    expect(nextReprojectionLevel(plain, new Set(['normal']))).toBeNull();
  });

  it('各通道媒体方言均可重投影（issue 实录文案）', () => {
    const dialects = [
      'image exceeds 5 MB maximum: 7414068 bytes > 5242880 bytes', // Anthropic 协议 issue 实录
      'image dimensions exceed max allowed size for many-image requests: 2000 pixels', // Anthropic 多图场景
      'You can only include 10 image links. Please reduce the number accordingly.', // Gemini/Vertex
      'At most 1 image(s) may be provided in one request.', // vLLM 推理端
      'Image base64 size (8.4 MB) exceeds API limit (5.0 MB).', // OpenAI 兼容网关 issue 实录
      "messages.content.type 参数非法，取值范围 ['text']", // 智谱 BigModel 实测（端点只收 text part）
      // 视频方言（2026-09-14 实录：某模型别名声明 video_in 但所用 openai 端点拒收视频，连挂两次 400）
      "400 The amount of videos you provided exceeds the model's limitation.",
      'too many videos in one request',
      'video exceeds maximum allowed size',
      // 尺寸下限方言（2026-10-06 session c527ea 实录，doubao 通道）：最小边 14px，
      // 「too small / Minimum allowed」不沾任何既有 exceed/limit/maximum 模式
      'BadRequest: image data 21 failed: Image dimensions are too small. Minimum allowed dimension: 14 pixels. Current dimension: 8 pixels.',
    ];
    for (const msg of dialects) {
      const err = new Anthropic.APIError(400, undefined, msg, undefined);
      expect(isReprojectableError(err), `方言应可重投影: ${msg}`).toBe(true);
    }
  });

  it('视频 400 可重投影并逐档剥掉视频（2026-09-14 事故回归钉）', () => {
    // 事故链路：isReprojectableError 漏配视频方言 → nextReprojectionLevel 返回 null
    // → adapter 原样重发 → 第二次同样的 400（实录两次间隔 4 秒）。本测试钉住分类
    // 与档位推进；档位真的能剥掉视频由 applyReprojectionLevel 的视频用例钉住。
    const videoErr = new Anthropic.APIError(
      400,
      undefined,
      "The amount of videos you provided exceeds the model's limitation.",
      undefined,
    );
    expect(isReprojectableError(videoErr)).toBe(true);
    const used = new Set<ReprojectionLevel>(['normal']);
    expect(nextReprojectionLevel(videoErr, used)).toBe('media-degraded');
  });

  it('500 / 429 / 无媒体关键词的裸 Error 不重投影', () => {
    expect(nextReprojectionLevel(new Anthropic.APIError(500, undefined, 'x', undefined), new Set(['normal']))).toBeNull();
    expect(nextReprojectionLevel(new Anthropic.APIError(429, undefined, 'x', undefined), new Set(['normal']))).toBeNull();
    expect(nextReprojectionLevel(new Error('boom'), new Set(['normal']))).toBeNull();
  });
});

const REPROJECTION_LEVELS_ALL: ReprojectionLevel[] = [
  'normal',
  'media-degraded',
  'media-stripped',
  'strict',
];

describe('withCapabilityProjection（发送前能力投影）', () => {
  it('image_in=false：请求消息里的图片被换成占位文本，历史原数组不动', async () => {
    const { withCapabilityProjection } = await import('../../src/provider/degrader.js');
    const { DEFAULT_CAPABILITY } = await import('../../src/provider/capability-registry.js');
    let seen: unknown;
    const fake = {
      stream(params: { messages: unknown }) {
        seen = params.messages;
        return {
          finalMessage: async () => ({ content: [], stop_reason: 'end_turn' }),
          [Symbol.asyncIterator]: async function* () {},
          abort() {},
        };
      },
    };
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' } },
          { type: 'text' as const, text: '看这个' },
        ],
      },
    ];
    const wrapped = withCapabilityProjection(fake as never, { ...DEFAULT_CAPABILITY, image_in: false });
    wrapped.stream({ messages } as never);
    const projected = (seen as typeof messages)[0]!.content;
    // 图片块变占位文本，文本块保留
    expect(projected.every((b) => b.type === 'text')).toBe(true);
    expect(projected.map((b) => (b as { text: string }).text).join('')).toContain('看这个');
    // 原历史没被改写（投影不改存储）
    expect(messages[0]!.content[0]!.type).toBe('image');
  });

  it('image_in=true：零包装原样返回（同一引用）', async () => {
    const { withCapabilityProjection } = await import('../../src/provider/degrader.js');
    const { DEFAULT_CAPABILITY } = await import('../../src/provider/capability-registry.js');
    const fake = { stream: () => ({}) };
    expect(withCapabilityProjection(fake as never, DEFAULT_CAPABILITY)).toBe(fake);
  });
});

describe('capVideos 单请求视频数上限（2026-09-24 事故）', () => {
  const msg = (blocks: unknown[]): Anthropic.MessageParam =>
    ({ role: 'user', content: blocks }) as Anthropic.MessageParam;
  const v = (data: string): unknown => ({
    type: 'video',
    source: { type: 'base64', media_type: 'video/mp4', data },
  });
  const toolResultWithVideo = (data: string): Anthropic.MessageParam =>
    ({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: '已读取视频' }, v(data)],
        },
      ],
    }) as unknown as Anthropic.MessageParam;

  it('两个视频超上限 1：保留最近的，更早的换占位文本', async () => {
    const { capVideos } = await import('../../src/provider/degrader.js');
    const messages = [msg([v('old')]), msg([v('new')])];
    const out = capVideos(messages, 1);
    expect(out).toHaveLength(2);
    expect(out[0]!.content[0]).toEqual({ type: 'text', text: '[video removed: exceeded per-request video limit]' });
    expect(out[1]!.content[0]).toMatchObject({ type: 'video' });
    // 不改入参
    expect(messages[0]!.content[0]).toMatchObject({ type: 'video' });
  });

  it('下钻 tool_result 内层：内嵌视频也参与计数与裁剪', async () => {
    const { capVideos } = await import('../../src/provider/degrader.js');
    const messages = [toolResultWithVideo('a'), toolResultWithVideo('b')];
    const out = capVideos(messages, 1);
    const first = out[0]!.content as unknown as { content: { type: string }[] }[];
    expect(first[0]!.content[0]!.type).toBe('text');
    expect(first[0]!.content[1]!.type).toBe('text');
    const second = out[1]!.content as unknown as { content: { type: string }[] }[];
    expect(second[0]!.content[1]!.type).toBe('video');
  });

  it('未超上限：原样返回同一引用（零分配）', async () => {
    const { capVideos } = await import('../../src/provider/degrader.js');
    const messages = [msg([v('only')])];
    expect(capVideos(messages, 1)).toBe(messages);
    expect(capVideos(messages, 2)).toBe(messages);
  });

  it('max_videos 缺省或为负：不裁剪（维持旧行为）', async () => {
    const { capVideos } = await import('../../src/provider/degrader.js');
    const messages = [msg([v('a')]), msg([v('b')]), msg([v('c')])];
    expect(capVideos(messages, undefined)).toBe(messages);
    expect(capVideos(messages, -1)).toBe(messages);
  });

  it('max_videos=0：全部视频换占位（一个都不发）', async () => {
    const { capVideos } = await import('../../src/provider/degrader.js');
    const out = capVideos([msg([v('a')]), msg([v('b')])], 0);
    expect(out.every((m) => (m.content as { type: string }[]).every((b) => b.type === 'text'))).toBe(true);
  });

  it('degradeMessages：声明 video_in + max_videos=1 时自动裁剪，会话不再被每轮 400 卡死', async () => {
    const { degradeMessages } = await import('../../src/provider/degrader.js');
    // 默认能力 video_in=false（历史视频本就全换占位）；这里验的是「收了视频」的模型
    // 在超上限时的裁剪行为，与 DEFAULT_CAPABILITY.max_videos=1 同一口径。
    const out = degradeMessages([msg([v('a')]), msg([v('b')])], {
      image_in: true,
      video_in: true,
      reasoning: true,
      cache_control: true,
      tool_use: true,
      max_context_tokens: 0,
      max_output_tokens: 0,
      max_videos: 1,
    });
    expect((out[0]!.content as { type: string }[])[0]!.type).toBe('text');
    expect((out[1]!.content as { type: string }[])[0]!.type).toBe('video');
  });
});

/**
 * 单请求媒体字节预算（kimi-code 同款思路，2026-10-06 源码调查引入）：
 * 历史里 base64 常驻且只增不减，字节预算掐住单请求体积峰值——
 * 撞堆（V8 fail-fast）与 413/400 超限的共同来源。
 */
describe('capMediaBytes 单请求媒体字节预算', () => {
  /** 造一块估算体积约 n 字节的图片（base64 字符数 × 0.75）。 */
  const imgOf = (bytes: number, tag: string): Anthropic.ContentBlockParam => {
    // 把 tag 垫到目标长度：data 全一样不好断言谁被驱逐，前缀 tag 便于识别
    const len = Math.ceil(bytes / 0.75);
    return {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: tag.padEnd(len, 'x') },
    } as unknown as Anthropic.ContentBlockParam;
  };
  const msg = (content: Anthropic.ContentBlockParam[]): Anthropic.MessageParam =>
    ({ role: 'user', content }) as Anthropic.MessageParam;

  it('未超预算原样返回同一引用（零拷贝快路径）', async () => {
    const { capMediaBytes } = await import('../../src/provider/degrader.js');
    const messages = [msg([imgOf(1000, 'a')])];
    expect(capMediaBytes(messages, 20 * 1024 * 1024, 10 * 1024 * 1024)).toBe(messages);
  });

  it('超预算从最旧的开始换占位，直到剩余 ≤ evictTo', async () => {
    const { capMediaBytes } = await import('../../src/provider/degrader.js');
    // 4 张各约 1MB：总量 4MB，预算 3MB，驱逐到 2.5MB → 最旧两张被换占位
    //（evictTo 留 0.5MB 余量：base64×0.75 估算有 ±1 字节舍入，贴边取值会让断言撞舍入）
    const messages = [
      msg([imgOf(1024 * 1024, 'img1')]),
      msg([imgOf(1024 * 1024, 'img2')]),
      msg([imgOf(1024 * 1024, 'img3')]),
      msg([imgOf(1024 * 1024, 'img4')]),
    ];
    const out = capMediaBytes(messages, 3 * 1024 * 1024, 2.5 * 1024 * 1024);
    const types = out.map((m) => (m.content as { type: string }[])[0]!.type);
    expect(types).toEqual(['text', 'text', 'image', 'image']);
    const first = (out[0]!.content as { text?: string }[])[0]!;
    expect(first.text).toContain('media byte budget');
    // 新图的 base64 原样保留
    expect(JSON.stringify(out[3])).toContain('img4');
  });

  it('下钻 tool_result 内嵌块：内层图片也计入预算并可被驱逐', async () => {
    const { capMediaBytes } = await import('../../src/provider/degrader.js');
    const inner = imgOf(2 * 1024 * 1024, 'inner');
    const toolResult = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: [inner],
    } as unknown as Anthropic.ContentBlockParam;
    const outer = imgOf(2 * 1024 * 1024, 'outer');
    const messages = [msg([toolResult]), msg([outer])];
    // 总量约 4MB，预算 3MB 驱逐到 2.5MB → 最旧的（内层 inner）被换占位，外层保留
    const out = capMediaBytes(messages, 3 * 1024 * 1024, 2.5 * 1024 * 1024);
    const tr = (out[0]!.content as { content: { type: string; text?: string }[] }[])[0]!;
    expect(tr.content[0]!.type).toBe('text');
    expect(tr.content[0]!.text).toContain('media byte budget');
    expect(JSON.stringify(out[1])).toContain('outer');
  });

  it('url source 不占请求体积（按 0 计），不因引用而误驱逐', async () => {
    const { capMediaBytes } = await import('../../src/provider/degrader.js');
    const urlImg = {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/a.png' },
    } as unknown as Anthropic.ContentBlockParam;
    const messages = [msg([urlImg]), msg([imgOf(2 * 1024 * 1024, 'b64')])];
    const out = capMediaBytes(messages, 3 * 1024 * 1024, 2 * 1024 * 1024);
    expect(out[0]).toBe(messages[0]); // url 图原样
    expect(JSON.stringify(out[1])).toContain('b64');
  });

  it('接入 degradeMessages 主动整形链：超预算历史在能力投影前已被瘦身', async () => {
    const big = Array.from({ length: 30 }, (_, i) =>
      msg([imgOf(1024 * 1024, `img${String(i).padStart(2, '0')}`)]),
    );
    // 30MB > 20MB 默认预算 → 最旧的一批被换占位，最近的保留
    const out = degradeMessages(big, FULL_CAPABILITY);
    const types = out.map((m) => (m.content as { type: string }[])[0]!.type);
    expect(types[0]).toBe('text');
    expect(types[types.length - 1]).toBe('image');
    // 剩余总量应 ≤ 10MB（驱逐目标）：数一下保留的 image 块不超过 10 张
    expect(types.filter((t) => t === 'image').length).toBeLessThanOrEqual(10);
  });
});
