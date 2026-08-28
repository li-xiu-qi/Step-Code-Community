/**
 * Circuit Breaker：per-provider 三态断路器，防止连续 429 时持续打同一个 provider。
 *
 * 状态机：
 *   CLOSED（正常） → 连续失败达到阈值 → OPEN（断路，跳过请求）
 *   OPEN → 冷却期过后 → HALF_OPEN（放行一次探测请求）
 *   HALF_OPEN → 成功 → CLOSED；失败 → 回到 OPEN
 *
 * 设计选择：
 * - 按 provider name 隔离（stepfun / openai / anthropic 各有独立断路器）
 * - 窗口期 60s：连续失败 5 次就断路
 * - 冷却期 120s：断路后等 2 分钟再放探测
 * - 断路器状态不持久化（重启后回 CLOSED）
 */

interface CircuitBreakerState {
  /** CLOSED | OPEN | HALF_OPEN */
  state: 'closed' | 'open' | 'half_open';
  /** 窗口内失败次数 */
  failures: number;
  /** 上次失败时间戳 */
  lastFailureAt: number;
  /** 进入 OPEN 的时间戳 */
  openedAt: number;
}

const CIRCUIT_FAILURE_THRESHOLD = 5;     // 连续失败 5 次触发断路
const CIRCUIT_WINDOW_MS = 60_000;        // 60 秒窗口
const CIRCUIT_COOLDOWN_MS = 120_000;     // 断路冷却 120 秒
const CIRCUIT_HALF_OPEN_MAX = 1;         // HALF_OPEN 时只放行 1 次探测

/**
 * 创建一个 per-provider 的 CircuitBreaker。
 */
export function createCircuitBreaker(): CircuitBreaker {
  const breakers = new Map<string, CircuitBreakerState>();
  return {
    allowRequest(providerName: string): boolean {
      const now = Date.now();
      const cb = getOrCreate(breakers, providerName);

      // CLOSED：正常放行
      if (cb.state === 'closed') return true;

      // OPEN：检查冷却期是否过
      if (cb.state === 'open') {
        if (now - cb.openedAt >= CIRCUIT_COOLDOWN_MS) {
          cb.state = 'half_open';
          cb.failures = 0;
          return true; // 放行一次探测
        }
        return false; // 仍在冷却期，拒绝
      }

      // HALF_OPEN：只放行一次
      if (cb.state === 'half_open') {
        if (cb.failures >= CIRCUIT_HALF_OPEN_MAX) {
          // 已经有探测在飞，拒绝新的
          return false;
        }
        return true;
      }

      return true;
    },

    recordSuccess(providerName: string): void {
      const cb = getOrCreate(breakers, providerName);
      if (cb.state === 'half_open') {
        // 探测成功，恢复
        cb.state = 'closed';
        cb.failures = 0;
      } else {
        // 重置窗口内计数
        cb.failures = 0;
      }
    },

    recordFailure(providerName: string): void {
      const now = Date.now();
      const cb = getOrCreate(breakers, providerName);

      // 清理窗口外的旧失败
      if (now - cb.lastFailureAt > CIRCUIT_WINDOW_MS) {
        cb.failures = 1;
      } else {
        cb.failures += 1;
      }
      cb.lastFailureAt = now;

      if (cb.failures >= CIRCUIT_FAILURE_THRESHOLD && cb.state === 'closed') {
        // 断路
        cb.state = 'open';
        cb.openedAt = now;
      }

      // HALF_OPEN 下探测失败，回到 OPEN
      if (cb.state === 'half_open') {
        cb.state = 'open';
        cb.openedAt = now;
      }
    },

    reset(providerName?: string): void {
      if (providerName !== undefined) {
        breakers.delete(providerName);
      } else {
        breakers.clear();
      }
    },
  };
}

export interface CircuitBreaker {
  allowRequest(providerName: string): boolean;
  recordSuccess(providerName: string): void;
  recordFailure(providerName: string): void;
  reset(providerName?: string): void;
}

function getOrCreate(
  map: Map<string, CircuitBreakerState>,
  key: string,
): CircuitBreakerState {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created: CircuitBreakerState = {
    state: 'closed',
    failures: 0,
    lastFailureAt: 0,
    openedAt: 0,
  };
  map.set(key, created);
  return created;
}
