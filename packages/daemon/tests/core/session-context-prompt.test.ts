import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSessionPromptWithContext } from '../../src/core/session-context-prompt.js';
import { addContextEntry, initContextResource } from '../../src/context/local-edge-store.js';

describe('session context prompt', () => {
  let previousHome: string | undefined;

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = previousHome;
    }
    previousHome = undefined;
  });

  it('injects locally resolved Context Vault entries requested by repo config', async () => {
    previousHome = process.env['HOME'];
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-context-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-context-repo-'));
    process.env['HOME'] = home;

    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.json'),
      JSON.stringify({
        version: 1,
        resources: {
          contexts: ['ctx-auth'],
        },
      }),
      'utf8',
    );

    const credentials = { passphrase: 'alice-passphrase', recoveryCode: 'alice-recovery' };
    await initContextResource({
      contextResourceId: 'ctx-auth',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      home: path.join(home, '.viewport'),
    });
    await addContextEntry({
      contextResourceId: 'ctx-auth',
      actorName: 'alice-laptop',
      title: 'Auth convention',
      body: 'Use signed session cookies for the dashboard.',
      scope: 'resource',
      credentials,
      home: path.join(home, '.viewport'),
    });

    const prompt = await buildSessionPromptWithContext({
      workingDirectory: repo,
      prompt: 'Review the current directory.',
    });

    expect(prompt).toContain('<viewport_context>');
    expect(prompt).toContain('## ctx-auth');
    expect(prompt).toContain('### Auth convention');
    expect(prompt).toContain('Use signed session cookies for the dashboard.');
    expect(prompt).toContain('<user_request>');
    expect(prompt).toContain('Review the current directory.');

    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it('leaves prompts unchanged when no repo config requests context', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-context-empty-'));

    await expect(
      buildSessionPromptWithContext({
        workingDirectory: repo,
        prompt: 'Just run tests.',
      }),
    ).resolves.toBe('Just run tests.');

    await fs.rm(repo, { recursive: true, force: true });
  });
});
