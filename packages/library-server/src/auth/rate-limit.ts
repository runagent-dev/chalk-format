/**
 * A fixed-window counter per key (a username, an address), kept in this process's memory. With more than one
 * instance behind a load balancer each counts on its own, so the real limit is the limit times the instances.
 */
export type RateLimiter = { hit(key: string): { ok: boolean; retryAfter: number }; reset(): void };

export function rateLimiter(limit: number, windowMs = 60_000, now: () => number = Date.now): RateLimiter {
  const seen = new Map<string, { n: number; until: number }>();
  return {
    hit(key) {
      const t = now();
      // forget finished windows now and then, so a flood of names cannot grow the map without end
      if (seen.size > 10_000) for (const [k, v] of seen) if (v.until <= t) seen.delete(k);
      for (const k of seen.keys()) { if (seen.size <= 100_000) break; seen.delete(k); }
      let w = seen.get(key);
      if (!w || w.until <= t) seen.set(key, (w = { n: 0, until: t + windowMs }));
      w.n += 1;
      return { ok: w.n <= limit, retryAfter: Math.max(1, Math.ceil((w.until - t) / 1000)) };
    },
    reset() { seen.clear(); },
  };
}
