/** Bound repeated optional work during an outage; a successful call closes it. */
export class FailureCooldown {
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  constructor(private readonly limit = 3, private readonly cooldownMs = 10 * 60_000) {}
  blocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (entry.retryAt <= now) { this.failures.delete(key); return false; }
    return entry.count >= this.limit;
  }
  failed(key: string, now = Date.now()): void {
    const prior = this.failures.get(key);
    if (this.failures.size >= 1000 && !prior) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(key, { count: (prior?.count || 0) + 1, retryAt: now + this.cooldownMs });
  }
  succeeded(key: string): void { this.failures.delete(key); }
}
