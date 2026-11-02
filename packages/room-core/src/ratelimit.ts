/** Small fixed-window rate limiter (per key). Memory is bounded by periodic pruning. */
export class RateLimiter {
  private hits = new Map<string, { count: number; start: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true when the action is allowed. */
  allow(key: string, now: number): boolean {
    const e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) {
      this.hits.set(key, { count: 1, start: now });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    if (e.count >= this.limit) return false;
    e.count++;
    return true;
  }

  prune(now: number) {
    for (const [k, e] of this.hits) if (now - e.start >= this.windowMs) this.hits.delete(k);
  }
}
