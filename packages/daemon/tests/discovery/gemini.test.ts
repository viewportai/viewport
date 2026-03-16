import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GeminiDiscovery } from '../../src/discovery/gemini.js';

describe('GeminiDiscovery', () => {
  let tmpRoot: string;
  let binDir: string;
  let projectDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-gemini-discovery-'));
    binDir = path.join(tmpRoot, 'bin');
    projectDir = path.join(tmpRoot, 'project');
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
  });

  afterEach(async () => {
    if (originalPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = originalPath;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeGeminiScript(body: string): Promise<void> {
    const scriptPath = path.join(binDir, 'gemini');
    await fs.writeFile(scriptPath, `#!/bin/sh\n${body}\n`, 'utf-8');
    await fs.chmod(scriptPath, 0o755);
  }

  it('prefers JSON output and filters sessions to the requested cwd', async () => {
    await writeGeminiScript(`
if [ "$1" = "--list-sessions" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
[
  {"sessionId":"gem-json-1","cwd":"${projectDir}","summary":"Fix flaky tests","messageCount":"12","updatedAt":"2026-03-01T12:00:00Z"},
  {"sessionId":"gem-json-2","cwd":"${projectDir}","title":"Ship release","message_count":4,"lastModified":1709337600},
  {"sessionId":"gem-json-other","cwd":"/tmp/other","summary":"ignore me"}
]
EOF
  exit 0
fi
echo "unexpected args" >&2
exit 1
`);

    const discovery = new GeminiDiscovery();
    const sessions = await discovery.discoverSessions(projectDir);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.sessionId).toBe('gem-json-1');
    expect(sessions[0]?.summary).toBe('Fix flaky tests');
    expect(sessions[0]?.messageCount).toBe(12);
    expect(sessions[1]?.sessionId).toBe('gem-json-2');
    expect(sessions[1]?.resumable).toBe(true);
    expect(sessions.every((s) => path.resolve(s.cwd) === path.resolve(projectDir))).toBe(true);
  });

  it('falls back to text parsing when JSON mode fails', async () => {
    await writeGeminiScript(`
if [ "$1" = "--list-sessions" ] && [ "$2" = "--json" ]; then
  echo "bad json"
  exit 0
fi
if [ "$1" = "--list-sessions" ]; then
  cat <<'EOF'
gem-text-0001  2026-03-01T10:00:00Z  Continue refactor
gem-text-0002\t2026-03-01T12:00:00Z\tResolve merge conflicts
EOF
  exit 0
fi
exit 1
`);

    const discovery = new GeminiDiscovery();
    const sessions = await discovery.discoverSessions(projectDir);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.sessionId).toBe('gem-text-0002');
    expect(sessions[0]?.summary).toContain('Resolve merge conflicts');
    expect(sessions[1]?.sessionId).toBe('gem-text-0001');
  });

  it('returns empty array when gemini CLI is unavailable or fails', async () => {
    await writeGeminiScript('exit 1');

    const discovery = new GeminiDiscovery();
    const sessions = await discovery.discoverSessions(projectDir);

    expect(sessions).toEqual([]);
  });

  it('supports wrapped JSON payloads with sessions array', async () => {
    await writeGeminiScript(`
if [ "$1" = "--list-sessions" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
{
  "sessions": [
    {"id":"gem-wrap-1","cwd":"${projectDir}","summary":"Wrapped session","updatedAt":"2026-03-01T12:00:00Z"}
  ]
}
EOF
  exit 0
fi
exit 1
`);

    const discovery = new GeminiDiscovery();
    const sessions = await discovery.discoverSessions(projectDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('gem-wrap-1');
    expect(sessions[0]?.summary).toBe('Wrapped session');
  });
});
