/**
 * 搜索提供商健康与冷却登记。
 *
 * 某家连续失败即进入冷却（按失败归类定时长），冷却期内路由直接跳过，
 * 避免每次搜索都为已死渠道付出一次超时。持久化到 ~/.step-code/search-health.json
 * （跨进程共享：plan 过期这类状态全天只需要发现一次）。读写全部 best-effort，
 * 文件损坏/不可写时退化为进程内内存态。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FailureKind } from './providers/types.js';

interface ProviderHealth {
  fails: number;
  cooldownUntil: number;
}

interface HealthFile {
  providers: Record<string, ProviderHealth>;
}

/** 冷却时长（ms）：配额类半天，解析/HTTP 类一小时，网络类五分钟，config 本进程跳过；fatal 不登记冷却（不应走到，防御 0）。 */
const COOLDOWN_MS: Record<FailureKind, number> = {
  quota: 6 * 60 * 60 * 1000,
  http: 60 * 60 * 1000,
  parse: 60 * 60 * 1000,
  network: 5 * 60 * 1000,
  config: 0,
  fatal: 0,
};

const FAILS_BEFORE_COOLDOWN = 2;

export class SearchHealth {
  private readonly path: string;
  private readonly state: Record<string, ProviderHealth>;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): Record<string, ProviderHealth> {
    try {
      if (!existsSync(this.path)) return {};
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as HealthFile;
      return typeof parsed.providers === 'object' && parsed.providers !== null ? parsed.providers : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ providers: this.state }, null, 1));
    } catch {
      // 写不进去就只活在本进程
    }
  }

  /** 冷却中 → true（路由应跳过）。 */
  isCooledDown(name: string, now = Date.now()): boolean {
    const h = this.state[name];
    return h !== undefined && h.cooldownUntil > now;
  }

  recordFailure(name: string, kind: FailureKind, now = Date.now()): void {
    const h = this.state[name] ?? { fails: 0, cooldownUntil: 0 };
    h.fails += 1;
    // config 类失败（缺 key）直接进入长冷却：本日内不值得再试
    const cooldown = kind === 'config' ? COOLDOWN_MS.quota : COOLDOWN_MS[kind];
    if (h.fails >= FAILS_BEFORE_COOLDOWN || kind === 'quota' || kind === 'config') {
      h.cooldownUntil = now + cooldown;
    }
    this.state[name] = h;
    this.persist();
  }

  recordSuccess(name: string): void {
    if (this.state[name] !== undefined) {
      delete this.state[name];
      this.persist();
    }
  }

  /** 测试与诊断用：读出当前冷却截止。 */
  cooldownUntil(name: string): number {
    return this.state[name]?.cooldownUntil ?? 0;
  }
}
