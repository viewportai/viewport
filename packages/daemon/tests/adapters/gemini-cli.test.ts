import { describe, it, expect, vi } from 'vitest';
import { GeminiCliAdapter } from '../../src/adapters/gemini-cli.js';
import type { SessionMessage } from '../../src/core/types.js';

describe('GeminiCliAdapter', () => {
  it('startSession emits user and agent messages via injected runner', async () => {
    const runCommand = vi.fn().mockResolvedValue({
      output: 'done',
      sessionId: 'gem-1',
    });
    const adapter = new GeminiCliAdapter(runCommand);

    const session = await adapter.startSession('/tmp/project', { initialPrompt: 'hello' });
    const messages: SessionMessage[] = [];
    session.on('message', (m: SessionMessage) => messages.push(m));

    await session.sendPrompt('next');

    expect(runCommand).toHaveBeenCalledWith({
      cwd: '/tmp/project',
      model: undefined,
      prompt: 'hello',
      resumeSessionId: undefined,
    });
    expect(runCommand).toHaveBeenCalledWith({
      cwd: '/tmp/project',
      model: undefined,
      prompt: 'next',
      resumeSessionId: 'gem-1',
    });
    expect(messages.some((m) => m.type === 'user_message')).toBe(true);
    expect(messages.some((m) => m.type === 'agent_message')).toBe(true);
  });

  it('resumeSession seeds resume id and default prompt', async () => {
    const runCommand = vi.fn().mockResolvedValue({
      output: 'continuing',
      sessionId: 'resume-1',
    });
    const adapter = new GeminiCliAdapter(runCommand);

    await adapter.resumeSession('resume-1', '/tmp/project');

    expect(runCommand).toHaveBeenCalledWith({
      cwd: '/tmp/project',
      model: undefined,
      prompt: 'Continue.',
      resumeSessionId: 'resume-1',
    });
  });
});
