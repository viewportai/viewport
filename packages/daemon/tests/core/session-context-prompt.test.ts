import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSessionContextBlock,
  buildSessionPromptWithContext,
} from '../../src/core/session-context-prompt.js';
import { proposeContextEntry } from '../../src/context/local-edge-candidates.js';
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
      prompt: 'Review dashboard authentication sessions.',
    });

    expect(prompt).toContain('<viewport_context>');
    expect(prompt).toContain('## ctx-auth');
    expect(prompt).toContain('### Auth convention');
    expect(prompt).toContain('Use signed session cookies for the dashboard.');
    expect(prompt).toContain('<user_request>');
    expect(prompt).toContain('Review dashboard authentication sessions.');

    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it('does not dump approved vault entries when the prompt has no relevant match', async () => {
    previousHome = process.env['HOME'];
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-context-no-dump-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-context-no-dump-repo-'));
    process.env['HOME'] = home;

    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.json'),
      JSON.stringify({
        version: 1,
        resources: {
          contexts: ['ctx-incidents'],
        },
      }),
      'utf8',
    );

    const credentials = { passphrase: 'alice-passphrase', recoveryCode: 'alice-recovery' };
    await initContextResource({
      contextResourceId: 'ctx-incidents',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      home: path.join(home, '.viewport'),
    });
    await addContextEntry({
      contextResourceId: 'ctx-incidents',
      actorName: 'alice-laptop',
      title: 'Incident-only sentinel',
      body: 'This should only appear for incident-related prompts.',
      scope: 'resource',
      credentials,
      home: path.join(home, '.viewport'),
    });

    const prompt = await buildSessionPromptWithContext({
      workingDirectory: repo,
      prompt: 'duration_ms 2770940 this shows up at the end instead of the time taken',
    });

    expect(prompt).not.toContain('<viewport_context>');
    expect(prompt).not.toContain('Incident-only sentinel');
    expect(prompt).not.toContain('This should only appear for incident-related prompts.');
    expect(prompt).toBe('duration_ms 2770940 this shows up at the end instead of the time taken');

    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it('injects repo-docs provider entries requested by yaml contract config', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-repo-docs-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(repo, 'docs', 'incident.md'),
      'Files under apps/api/Auth require session rotation tests.',
      'utf8',
    );
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: repo_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
        '',
      ].join('\n'),
      'utf8',
    );

    const prompt = await buildSessionPromptWithContext({
      workingDirectory: repo,
      prompt: 'Review auth changes.',
    });

    expect(prompt).toContain('<viewport_context>');
    expect(prompt).toContain('## repo_docs (repo-docs)');
    expect(prompt).toContain('### docs/incident.md');
    expect(prompt).toContain('Files under apps/api/Auth require session rotation tests.');
    expect(prompt).toContain('<user_request>');
    expect(prompt).toContain('Review auth changes.');

    await fs.rm(repo, { recursive: true, force: true });
  });

  it('does not inject repo-docs provider bodies for unrelated prompts', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-repo-docs-no-dump-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(repo, 'docs', 'incident.md'),
      'Files under apps/api/Auth require session rotation tests.',
      'utf8',
    );
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: repo_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
        '',
      ].join('\n'),
      'utf8',
    );

    const prompt = await buildSessionPromptWithContext({
      workingDirectory: repo,
      prompt: 'duration_ms 2770940 this shows up at the end instead of the time taken',
    });

    expect(prompt).toBe('duration_ms 2770940 this shows up at the end instead of the time taken');
    expect(prompt).not.toContain('<viewport_context>');
    expect(prompt).not.toContain('Files under apps/api/Auth');

    await fs.rm(repo, { recursive: true, force: true });
  });

  it('injects viewport-vault use and update guidance before body retrieval', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-vault-guidance-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: platform_guardrails',
        '      provider: viewport-vault',
        '      vault: ctx-platform',
        '      use_when: Use when changing auth, billing, or permissions.',
        '      update_when: Update after durable policy or incident lessons change.',
        '',
      ].join('\n'),
      'utf8',
    );

    const block = await buildSessionContextBlock({
      workingDirectory: repo,
      query: 'change auth permissions',
      includePendingLocal: true,
    });

    expect(block).toContain('## ctx-platform');
    expect(block).toContain(
      'Use this context when: Use when changing auth, billing, or permissions.',
    );
    expect(block).toContain(
      'Propose an update when: Update after durable policy or incident lessons change.',
    );
    expect(block).toContain('Context Vault is configured but not available on this machine.');

    await fs.rm(repo, { recursive: true, force: true });
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

  it('labels author-local candidates as pending local context without treating them as approved', async () => {
    previousHome = process.env['HOME'];
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-pending-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-pending-repo-'));
    process.env['HOME'] = home;

    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.json'),
      JSON.stringify({
        version: 1,
        resources: {
          contexts: ['ctx-incidents'],
        },
      }),
      'utf8',
    );

    const credentials = { passphrase: 'alice-passphrase', recoveryCode: 'alice-recovery' };
    await initContextResource({
      contextResourceId: 'ctx-incidents',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      home: path.join(home, '.viewport'),
    });
    await proposeContextEntry({
      contextResourceId: 'ctx-incidents',
      actorName: 'alice-laptop',
      title: 'Incident followup',
      body: 'Firestore incidents require replaying the webhook fixture before release.',
      source: 'test://pending',
      credentials,
      home: path.join(home, '.viewport'),
    });

    const block = await buildSessionContextBlock({
      workingDirectory: repo,
      query: 'incident webhook release',
      includePendingLocal: true,
    });

    expect(block).toContain('### Incident followup');
    expect(block).toContain('Trust: pending_local');
    expect(block).toContain('not approved team context');
    expect(block).not.toContain('Trust: approved');

    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
});
