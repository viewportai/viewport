import type { RelayLogEntry } from './types.js';

const SENSITIVE_KEY_PATTERN =
  /(authorization|credential|token|secret|password|api[_-]?key|private[_-]?key|signature|payload|body|content|frame|message)/i;

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
      details: redactLogValue(details) as Record<string, unknown>,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs);
    }
    // Structured logs for production log collectors.
    console.log(JSON.stringify(entry));
  }
}

function redactLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactLogValue(entry));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redactLogValue(entry),
    ]),
  );
}
