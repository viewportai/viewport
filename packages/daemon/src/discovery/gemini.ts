/**
 * Gemini session discovery.
 *
 * Preferred source: `gemini --list-sessions --json`.
 * Fallback source: `gemini --list-sessions` (text parsing).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { DiscoveredSession, SessionDiscovery } from '../core/interfaces.js';

const execFileAsync = promisify(execFile);

export class GeminiDiscovery implements SessionDiscovery {
  readonly agentId = 'gemini';

  async discoverSessions(projectPath: string): Promise<DiscoveredSession[]> {
    const cwd = path.resolve(projectPath);

    const fromJson = await this.listWithJson(cwd);
    if (fromJson.length > 0) return fromJson;

    return this.listWithText(cwd);
  }

  private async listWithJson(projectPath: string): Promise<DiscoveredSession[]> {
    try {
      const { stdout } = await execFileAsync('gemini', ['--list-sessions', '--json'], {
        cwd: projectPath,
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as unknown;
      const sessions = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' &&
            parsed !== null &&
            Array.isArray((parsed as { sessions?: unknown }).sessions)
          ? ((parsed as { sessions: unknown[] }).sessions ?? [])
          : [];
      return sessions
        .map((item) => this.fromRecord(item, projectPath))
        .filter((item): item is DiscoveredSession => !!item)
        .sort((a, b) => b.lastModified - a.lastModified);
    } catch {
      return [];
    }
  }

  private async listWithText(projectPath: string): Promise<DiscoveredSession[]> {
    try {
      const { stdout } = await execFileAsync('gemini', ['--list-sessions'], {
        cwd: projectPath,
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const out: DiscoveredSession[] = [];

      for (const line of stdout.split('\n')) {
        const parsed = parseTextLine(line, projectPath);
        if (parsed) out.push(parsed);
      }

      out.sort((a, b) => b.lastModified - a.lastModified);
      return out;
    } catch {
      return [];
    }
  }

  private fromRecord(value: unknown, projectPath: string): DiscoveredSession | null {
    if (typeof value !== 'object' || value === null) return null;
    const rec = value as Record<string, unknown>;

    const sessionId = firstString(rec['sessionId'], rec['session_id'], rec['id']);
    if (!sessionId) return null;

    const cwd = firstString(rec['cwd'], rec['projectPath'], rec['workdir']) ?? projectPath;
    if (path.resolve(cwd) !== path.resolve(projectPath)) return null;

    const summary = (
      firstString(rec['summary'], rec['title'], rec['prompt']) ?? 'Gemini session'
    ).slice(0, 120);

    const messageCount = firstNumber(rec['messageCount'], rec['message_count'], rec['turnCount']);
    const lastModified =
      firstTimestamp(rec['lastModified'], rec['updatedAt'], rec['timestamp'], rec['createdAt']) ??
      Date.now();

    return {
      agentId: this.agentId,
      sessionId,
      summary,
      lastModified,
      cwd,
      resumable: true,
      messageCount: messageCount ?? undefined,
    };
  }
}

function parseTextLine(line: string, projectPath: string): DiscoveredSession | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed
    .split(/\s{2,}|\t+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  // Common format: "<sessionId>  <date>  <summary...>"
  const idMatch = parts[0]?.match(/^[A-Za-z0-9._:-]{8,}$/);
  if (!idMatch) return null;
  const sessionId = idMatch[0];
  const summary = (parts.slice(2).join(' ') || parts[1] || 'Gemini session').slice(0, 120);
  const dateCandidate = parts[1] || '';
  const parsedDate = Date.parse(dateCandidate);

  return {
    agentId: 'gemini',
    sessionId,
    summary,
    lastModified: Number.isFinite(parsedDate) ? parsedDate : Date.now(),
    cwd: projectPath,
    resumable: true,
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstTimestamp(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1_000_000_000_000 ? value : value * 1000;
    }
    if (typeof value === 'string') {
      const parsedDate = Date.parse(value);
      if (Number.isFinite(parsedDate)) return parsedDate;
      const parsedNum = Number(value);
      if (Number.isFinite(parsedNum)) return parsedNum;
    }
  }
  return undefined;
}
