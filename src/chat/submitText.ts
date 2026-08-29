/**
 * 提交文本的规范化：从编辑器取实际发送内容。
 *
 * 为什么单独抽出来：pi-tui Editor 把大段粘贴折叠成 `[paste #N +X lines]` 占位符，
 * 真实内容存在内部 `pastes` Map 里。`getText()` 返回的是折叠形态，
 * 直接发出去模型只会看到占位符——这是「输入和实际发送不一致」的经典形态。
 *
 * 故提交必须走 `getExpandedText()`。这段逻辑原本内联在 PiChat.onSubmit 里，
 * 内联导致无法单测（要驱动整个 PiChat），变异测试也测不到它——曾经把
 * `getExpandedText` 改成 `getText`，测试全绿，bug 静默通过。抽出后可直接断言。
 */

/** 编辑器取文本的最小接口（与 pi-tui Editor 的两个方法对应）。 */
export interface SubmitTextSource {
  /** 缓冲区原文（粘贴可能是占位符）。 */
  getText(): string;
  /** 占位符还原后的完整文本。 */
  getExpandedText(): string;
}

/**
 * 算出实际要发送的文本。
 *
 * 优先级：展开文本优先；展开文本为空（用户没粘过大段东西）时退回 onSubmit 入参
 * ——那个入参是 Editor 提交时传的，本身已经展开过，两者等价，取展开文本是为了
 * 覆盖「onSubmit 之后又粘了内容」这种边界。
 *
 * 末尾 trim：编辑器末尾常带一个多余换行（Enter 提交时留下），不去掉会让模型
 * 收到一个尾部空行，某些 provider 会据此多算一轮。
 */
export function resolveSubmitText(src: SubmitTextSource, onSubmitArg: string): string {
  const expanded = src.getExpandedText();
  return (expanded === '' ? onSubmitArg : expanded).trim();
}
