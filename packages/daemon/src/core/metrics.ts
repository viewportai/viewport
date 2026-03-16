/**
 * In-memory metrics collector for the Viewport daemon.
 * Tracks counters and gauges for observability.
 */

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  timestamp: number;
}

export class MetricsCollector {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();

  /** Increment a counter by 1 (or n). */
  increment(name: string, n = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }

  /** Set a gauge to a specific value. */
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Get current snapshot. */
  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      timestamp: Date.now(),
    };
  }

  /** Reset all metrics. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }
}

/** Global singleton. */
export const metrics = new MetricsCollector();
