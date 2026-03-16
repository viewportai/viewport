export class RelayMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, value] of this.counters.entries()) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }
    for (const [name, value] of this.gauges.entries()) {
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }
    return lines.join('\n') + '\n';
  }
}
