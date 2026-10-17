/** One global in-memory token bucket; deliberately keyed by nothing, not even IP. */
export class TokenBucket {
  #tokens: number;
  #last: number;
  private readonly capacity: number;
  private readonly perMinute: number;
  private readonly now: () => number;
  constructor(
    capacity: number,
    perMinute: number,
    now: () => number = () => Date.now(),
  ) {
    this.capacity = capacity;
    this.perMinute = perMinute;
    this.now = now;

    this.#tokens = capacity;
    this.#last = now();
  }
  take(): boolean {
    const at = this.now();
    this.#tokens = Math.min(
      this.capacity,
      this.#tokens + ((at - this.#last) / 60_000) * this.perMinute,
    );
    this.#last = at;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
