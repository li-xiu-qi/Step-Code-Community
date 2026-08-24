import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** 跨 session 消息：一个 session 投递给另一个 session 的指令。 */
export interface SessionQueueMessage {
  id: string;
  /** 发送方 session id。 */
  from: string;
  /** 目标 session id。 */
  to: string;
  /** 投递的指令正文。 */
  text: string;
  /** 投递时刻（ISO）。 */
  createdAt: string;
  /** 被目标 session 消费的时刻（ISO）；undefined 表示待消费。 */
  consumedAt?: string;
}

/**
 * 跨 session 消息队列：允许一个会话给另一个会话投递指令，目标会话在 run 启动时
 * drain 并注入为新一轮 user 消息继续执行。
 *
 * 落盘范式同会话存储：JSON 行式（append-only JSONL），非关系库。每个目标会话一份
 * `<dir>/<to>.json` 文件。目录全局、不按工作目录分桶——消息天然跨工作目录流转，
 * 这是它和按 cwd 分桶的定时任务目录的根本区别。
 *
 * 消费是「拉取 + 标记」而非「推送」：目标会话每次 run 启动时主动 drain，避免常驻
 * watcher；代价是目标会话若完全空闲且无后续 run，消息会等到下次启动/resume 才被消费。
 */
export class SessionQueueStore {
  constructor(private readonly dir: string) {}

  /** 目标会话的队列文件路径。 */
  private fileFor(to: string): string {
    return `${this.dir}/${to}.json`;
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /** 投递：往目标会话队列追加一条消息，返回消息 id。 */
  enqueue(to: string, from: string, text: string): string {
    this.ensureDir();
    const msg: SessionQueueMessage = {
      id: randomUUID(),
      from,
      to,
      text,
      createdAt: new Date().toISOString(),
    };
    appendFileSync(this.fileFor(to), JSON.stringify(msg) + '\n', 'utf8');
    return msg.id;
  }

  /** 读取目标会话的未消费消息（不标记消费，纯查看）。 */
  peek(to: string): SessionQueueMessage[] {
    return this.readAll(to).filter((m) => m.consumedAt === undefined);
  }

  /**
   * 取出目标会话的未消费消息并标记为已消费。原子重写文件（读→标记→临时文件→rename），
   * 已消费行保留作审计，未消费行打上 consumedAt 后写回。
   */
  drain(to: string): SessionQueueMessage[] {
    const file = this.fileFor(to);
    if (!existsSync(file)) return [];
    const all = this.readAll(to);
    const now = new Date().toISOString();
    const pending: SessionQueueMessage[] = [];
    const lines: string[] = [];
    for (const m of all) {
      if (m.consumedAt === undefined) {
        m.consumedAt = now;
        pending.push(m);
      }
      lines.push(JSON.stringify(m));
    }
    // 原子写回：先写临时文件再 rename，防进程死在写入中途丢消息。
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
    renameSync(tmp, file);
    return pending;
  }

  /** 读取某目标会话队列文件的所有消息（容忍崩溃截断的尾行）。 */
  private readAll(to: string): SessionQueueMessage[] {
    const file = this.fileFor(to);
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    const out: SessionQueueMessage[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as SessionQueueMessage);
      } catch {
        // 截断尾行容忍：进程死于写入中途时丢弃半行，不污染整文件。
      }
    }
    return out;
  }
}
