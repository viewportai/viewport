import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPairingClientIdentity,
  createPairingRedeemProof,
  rotateAuthToken,
} from '../../src/server/pairing-offers.js';
import { daemonFetch } from '../../src/cli/daemon-client.js';
import { FullstackCliHarness } from './support/fullstack-cli-harness.js';

interface CommandResult {
  logs: string[];
  errors: string[];
}

function parseJsonLog(logs: string[]): Record<string, unknown> {
  for (const entry of logs) {
    try {
      return JSON.parse(entry) as Record<string, unknown>;
    } catch {
      // continue
    }
  }
  throw new Error(`Expected JSON output, got: ${logs.join('\n')}`);
}

async function runCliCommand(
  args: string[],
  modulePath: string,
  exportName: string,
): Promise<CommandResult> {
  vi.resetModules();
  process.argv = ['node', 'vpd', ...args];
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map((part) => String(part)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    errors.push(parts.map((part) => String(part)).join(' '));
  });
  try {
    const mod = (await import(modulePath)) as Record<string, () => Promise<void>>;
    const command = mod[exportName];
    if (typeof command !== 'function') {
      throw new Error(`Missing export ${exportName} in ${modulePath}`);
    }
    await command();
    return { logs, errors };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('fullstack CLI workflow e2e', () => {
  let harness: FullstackCliHarness | null = null;
  const originalArgv = process.argv.slice();

  afterEach(async () => {
    process.argv = originalArgv;
    if (harness) {
      await harness.close();
      harness = null;
    }
  });

  const fullstackNetworkEnabled = process.env['VIEWPORT_RUN_NET_E2E'] === '1';
  const runOrSkip = fullstackNetworkEnabled ? it : it.skip;

  runOrSkip(
    'proves run/list/worktree/pair/session-stop end-to-end on real HTTP+WS server',
    async () => {
      harness = await FullstackCliHarness.start();
      const projectPath = await harness.createGitProject();

      const runResult = await runCliCommand(
        ['run', projectPath, '--prompt', 'create tracked file', '--json'],
        '../../src/cli/orchestration-commands.js',
        'runSession',
      );
      const runPayload = parseJsonLog(runResult.logs);
      expect(runPayload['ok']).toBe(true);
      expect(typeof runPayload['sessionId']).toBe('string');
      const sessionId = String(runPayload['sessionId']);

      const lsResult = await runCliCommand(
        ['ls', '--scope', 'active', '--format', 'table'],
        '../../src/cli/session-commands.js',
        'listSessions',
      );
      expect(lsResult.logs.join('\n')).toContain('Session');
      expect(lsResult.logs.join('\n')).toContain(sessionId);

      const setModeResult = await runCliCommand(
        ['agent', 'mode', sessionId, 'bypass', '--json'],
        '../../src/cli/agent-commands.js',
        'agent',
      );
      const setModePayload = parseJsonLog(setModeResult.logs);
      expect(setModePayload['ok']).toBe(true);

      const getModeResult = await runCliCommand(
        ['agent', 'mode', sessionId, '--json'],
        '../../src/cli/agent-commands.js',
        'agent',
      );
      const getModePayload = parseJsonLog(getModeResult.logs);
      expect(getModePayload['mode']).toBe('bypass');

      const worktree = harness.daemonInstance.listWorktrees(sessionId)[0];
      expect(worktree).toBeTruthy();
      const worktreePath = worktree!.worktreePath;
      await fs.writeFile(path.join(worktreePath, 'tracked.txt'), 'hello from e2e\n', 'utf-8');

      const fakeSession = harness.fakeAdapter.getLatestSession();
      expect(fakeSession).toBeTruthy();
      fakeSession!.emitMessage({
        type: 'tool_call_update',
        toolCallId: 'tc-1',
        toolName: 'Write',
        status: 'completed',
        title: 'write tracked file',
        timestamp: Date.now(),
      });

      const stepDiffs = await waitFor(async () => {
        const diffs = await harness!.daemonInstance.getSessionDiffs(sessionId);
        return diffs.length > 0 ? diffs : null;
      });
      const firstSha = stepDiffs[0]!.sha;
      expect(firstSha.length).toBeGreaterThan(6);

      const diffsResult = await runCliCommand(
        ['worktree', 'diffs', sessionId, '--json'],
        '../../src/cli/worktree-commands.js',
        'worktree',
      );
      const diffsPayload = parseJsonLog(diffsResult.logs) as {
        diffs?: Array<{ sha: string; diff: string }>;
      };
      expect(Array.isArray(diffsPayload.diffs)).toBe(true);
      expect(diffsPayload.diffs![0]!.sha).toBe(firstSha);
      expect(diffsPayload.diffs![0]!.diff).toContain('tracked.txt');

      const summaryResult = await runCliCommand(
        ['worktree', 'summary', sessionId, '--json'],
        '../../src/cli/worktree-commands.js',
        'worktree',
      );
      const summaryPayload = parseJsonLog(summaryResult.logs);
      expect(String(summaryPayload['diff'])).toContain('tracked.txt');

      const retryResult = await runCliCommand(
        ['worktree', 'retry', sessionId, firstSha, '--json'],
        '../../src/cli/worktree-commands.js',
        'worktree',
      );
      const retryPayload = parseJsonLog(retryResult.logs);
      expect(typeof retryPayload['retryPath']).toBe('string');

      const branch = await harness.currentBranch(projectPath);
      const squashResult = await runCliCommand(
        ['worktree', 'squash', sessionId, '--target', branch, '--message', 'e2e squash', '--json'],
        '../../src/cli/worktree-commands.js',
        'worktree',
      );
      const squashPayload = parseJsonLog(squashResult.logs);
      expect(squashPayload['ok']).toBe(true);

      await rotateAuthToken();
      const offerResponse = await daemonFetch('/api/pair/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlSeconds: 60 }),
      });
      expect(offerResponse?.status).toBe(200);
      const offer = (await offerResponse?.json()) as {
        offerId?: string;
        redeemSecret?: string;
        trustAnchor?: string;
      };
      expect(offer.offerId).toBeTruthy();
      expect(offer.redeemSecret).toBeTruthy();
      expect(offer.trustAnchor).toBeTruthy();
      const clientIdentity = createPairingClientIdentity();
      const clientProof = createPairingRedeemProof({
        offerId: offer.offerId!,
        redeemSecret: offer.redeemSecret!,
        trustAnchor: offer.trustAnchor!,
        clientIdentity,
      });

      const redeemOk = await daemonFetch('/api/pair/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId: offer.offerId!,
          proof: offer.redeemSecret!,
          trustAnchor: offer.trustAnchor!,
          clientPublicKey: clientProof.clientPublicKey,
          clientProof: clientProof.clientProof,
        }),
      });
      expect(redeemOk?.status).toBe(200);
      const redeemBody = (await redeemOk?.json()) as { peerId?: string; daemonDeviceId?: string };
      expect(redeemBody?.peerId).toBe(clientIdentity.peerId);
      expect(redeemBody?.daemonDeviceId).toBeTruthy();

      const redeemMismatch = await daemonFetch('/api/pair/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId: offer.offerId!,
          proof: offer.redeemSecret!,
          trustAnchor: 'dead:beef',
          clientPublicKey: clientProof.clientPublicKey,
          clientProof: clientProof.clientProof,
        }),
      });
      expect(redeemMismatch?.status).toBe(404);

      const stopResult = await runCliCommand(
        ['session', 'stop', sessionId, '--json'],
        '../../src/cli/session-commands.js',
        'stopSession',
      );
      const stopPayload = parseJsonLog(stopResult.logs);
      expect(stopPayload['ok']).toBe(true);
    },
  );
});
