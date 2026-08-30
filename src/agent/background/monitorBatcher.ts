/**
 * 行缓冲器：把 stdout 数据流切成「事件批次」。
 *
 * 逆向自 claude-code-win32-x64@2.1.251，四个常数是源码里量出来的，不是拍脑袋：
 *
 *   buf 上限 1 MB  —— 防失控进程写满内存（2026-08-10 事故同源风险）
 *   flush 200 ms   —— 窗口内多行合并为一条通知，tail -f 刷屏时几十行只变一条
 *   单行 500 字符  —— 超长行砍断
 *   整批 3000 字符 —— 一批所有行合计超限也砍断
 *
 * 为什么不是「每行一个事件」：模型推理需要时间，逐行推送会让一个刷屏的日志
 * 产生几十次模型调用。200ms 合并后模型看到的是「这段时间内发生了什么」，
 * 不是「这一行发生了什么」。这才是「有事才叫它」的实际含义。
 *
 * 纯函数无副作用，输入输出都可断言，是这条链路上唯一能单测的部分。
 */

/** 缓冲上限（字节）：超过只保留尾部，防内存膨胀。 */
export const MAX_MONITOR_BUF = 1024 * 1024;
/** flush 延迟（毫秒）：窗口内多行合并为一条。 */
export const MONITOR_FLUSH_MS = 200;
/** 单行截断（字符）。 */
export const MONITOR_LINE_CAP = 500;
/** 整批截断（字符）。 */
export const MONITOR_BATCH_CAP = 3000;

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...(truncated)` : text;
}

export interface MonitorBatcher {
  /** 喂一块 stdout 数据。返回是否新起了一个待触发的 flush 窗口。 */
  push(chunk: string): boolean;
  /**
   * 到期或强制 flush。
   * force=true 时把残余的半行也凑成一行（进程退出前的最后输出）。
   * 返回要投递的正文，无内容时返回 null。
   */
  flush(force?: boolean): string | null;
  /** 当前积压的完整行数（测试与诊断用）。 */
  pending(): number;
}

/**
 * 建一个行缓冲器。emit 由调用方在 flush 返回非 null 时调用，
 * 缓冲器本身不持有投递通道，便于单测。
 */
export function createMonitorBatcher(): MonitorBatcher {
  let buf = '';
  let lines: string[] = [];

  return {
    push(chunk: string): boolean {
      buf += chunk;
      if (buf.length > MAX_MONITOR_BUF) buf = buf.slice(-MAX_MONITOR_BUF);
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) lines.push(cap(line, MONITOR_LINE_CAP));
      }
      // 只在从无到有时起窗口：已有窗口在跑就不重复起，避免每次 push 都重置计时。
      return lines.length > 0;
    },

    flush(force = false): string | null {
      if (force && buf.trim()) {
        lines.push(cap(buf.trim(), MONITOR_LINE_CAP));
        buf = '';
      }
      if (lines.length === 0) return null;
      const body = cap(lines.join('\n'), MONITOR_BATCH_CAP);
      lines = [];
      return body;
    },

    pending(): number {
      return lines.length;
    },
  };
}
