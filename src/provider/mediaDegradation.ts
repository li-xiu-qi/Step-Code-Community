import type Anthropic from '@anthropic-ai/sdk';
import { applyReprojectionLevel, nextReprojectionLevel, type ReprojectionLevel } from './degrader.js';
import type { ChatProvider } from './types.js';

/**
 * 全通道媒体降级 wrapper：给任意 ChatProvider 包上「媒体超限 → 降级重投影 → 重试」。
 *
 * 背景：StepfunAdapter 的 send() 里实现了错误驱动重投影（413/400 → 沿
 * normal → media-degraded → media-stripped → strict 逐档降级重发），但那套
 * 循环绑死在 stepfun adapter 内，anthropic / openai / openai_responses 通道
 * 遇到同样的超限（Anthropic `image exceeds 5 MB maximum`、Gemini `10 image
 * links`、通用 `Payload Too Large`）只能直接抛错——历史里滞留的超限图会让
 * 会话永久损坏（公开 issue 里有挂数月未修的真实事故）。
 *
 * 这个 wrapper 把重投影循环抽成通道无关的装饰器：包在任何 ChatProvider 外，
 * stream 抛错时按 degrader 的方言识别（isReprojectableError）判断能否降级，
 * 能则换消息重发，每档每请求最多一次（used 集合熔断，防 400 无限循环）。
 *
 * 与 withHistoryNormalization 正交：那个管历史结构整形，这个管发送时的媒体
 * 降级兜底，包装顺序无所谓（一个请求前整形、一个发送时兜底）。
 *
 * 实现要点：ChatProvider.stream 是同步返回流句柄的接口，重试只能发生在
 * 异步阶段。本 wrapper 返回代理流句柄，拦截两个错误面：
 * - finalMessage：媒体 400 在流正常结束后才抛的通道（原有路径）；
 * - 迭代器 next()：OpenAI 兼容通道的 fetch 在首个事件拉取时才发请求，
 *   400 在迭代起点就抛出，永远走不到 finalMessage（2026-10-06 session c527ea
 *   实证：stepfun-plan 通道 10 张图被 images_too_many 拒绝，重试链全程未触发）。
 *   迭代重试只在「零事件已吐出」时发生——吐过事件再重发会把正文重复上屏。
 * 两条路径共享同一份 used/messages/当前流状态，迭代已降过的档 finalMessage 不重复降。
 */

/** wrapper 构造参数。 */
export interface MediaDegradationOptions {
  /**
   * media-degraded 档保留的最近图片张数（config.toml media_keep_recent）。
   * 缺省 10（step-3.7 实测 60 张上限的 1/6 安全值，日常几乎不触发、触发时
   * 保留足够上下文）；0 = 全部换占位（旧行为）。
   */
  keepRecentImages?: number;
}

type StreamHandle = ReturnType<ChatProvider['stream']>;
type StreamParams = Parameters<ChatProvider['stream']>[0];

/**
 * 包装一个 ChatProvider：stream 的迭代与 finalMessage 遇可重投影错误时沿降级链重试。
 * 其他属性/方法原样透传（用原型链 + 属性拷贝保留 inner 的完整形态）。
 */
export function withMediaDegradation<T extends ChatProvider>(
  inner: T,
  options: MediaDegradationOptions = {},
): T {
  const keepRecent = options.keepRecentImages ?? 10;
  const wrapped = Object.create(Object.getPrototypeOf(inner)) as T;
  Object.assign(wrapped, inner);
  wrapped.stream = (params: StreamParams): StreamHandle =>
    wrapStream(inner, params, keepRecent);
  return wrapped;
}

/** 发起一次 stream：迭代期与 finalMessage 期的媒体错误都沿降级链重发。 */
function wrapStream(inner: ChatProvider, params: StreamParams, keepRecent: number): StreamHandle {
  /** 两条错误路径共享的可变状态：当前流、当前消息（可能已降级）、已用档位。 */
  const state = {
    used: new Set<ReprojectionLevel>(['normal']),
    messages: params.messages,
    stream: inner.stream(params),
  };
  /** 能降级就换档重发（更新 state），不能就把错误原样抛出。 */
  const degradeOrThrow = (err: unknown): void => {
    const level = nextReprojectionLevel(err, state.used);
    if (level === null) throw err;
    state.used.add(level);
    state.messages = applyReprojectionLevel(state.messages, level, keepRecent);
    state.stream = inner.stream({ ...params, messages: state.messages });
  };
  return new Proxy(state.stream, {
    get(_target, prop, receiver) {
      if (prop === 'finalMessage') {
        return async (): Promise<Anthropic.Message> => {
          for (;;) {
            try {
              return await state.stream.finalMessage();
            } catch (err) {
              degradeOrThrow(err);
            }
          }
        };
      }
      if (prop === Symbol.asyncIterator) {
        return (): AsyncIterableIterator<unknown> => {
          let emitted = false;
          let it: AsyncIterator<unknown> = state.stream[Symbol.asyncIterator]();
          const self: AsyncIterableIterator<unknown> = {
            async next(...args) {
              for (;;) {
                try {
                  const r = await it.next(...args);
                  if (!r.done) emitted = true;
                  return r;
                } catch (err) {
                  // 已吐出事件后不再重试：重发会让同一段正文/思考重复上屏。
                  // 零事件时的错误（典型：首个拉取才发请求的通道撞上 400）换档重发。
                  if (emitted) throw err;
                  degradeOrThrow(err);
                  it = state.stream[Symbol.asyncIterator]();
                }
              }
            },
            async return(...args) {
              return it.return !== undefined ? it.return(...args) : { done: true as const, value: undefined };
            },
            [Symbol.asyncIterator]() {
              return self;
            },
          };
          return self;
        };
      }
      // 其他属性从当前流读取（降级重发后 state.stream 已换新句柄）
      const v = Reflect.get(state.stream, prop, receiver);
      return typeof v === 'function' ? v.bind(state.stream) : v;
    },
  });
}
