import type { RelayLogEntry } from './types.js';

export class RelayLogger {
  private readonly logs: RelayLogEntry[] = [];

  constructor(private readonly maxLogs: number) {}

  info(event: string, details: Record<string, unknown> = {}): void {
    this.push('info', event, details);
  }

  warn(event: string, details: Record<string, unknown> = {}): void {
    this.push('warn', event, details);
  }

  error(event: string, details: Record<string, unknown> = {}): void {
    this.push('error', event, details);
  }

  recent(): RelayLogEntry[] {
    return this.logs.slice(-this.maxLogs);
  }

  recentSummaries(): Array<Pick<RelayLogEntry, 'ts' | 'level' | 'event'>> {
    return this.logs.slice(-this.maxLogs).map((entry) => ({
      ts: entry.ts,
      level: entry.level,
      event: entry.event,
    }));
  }

  private push(
    level: RelayLogEntry['level'],
    event: string,
    details: Record<string, unknown>,
  ): void {
    const entry: RelayLogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      details,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs);
    }
    // Structured logs for production log collectors.
    console.log(JSON.stringify(entry));
  }
}
