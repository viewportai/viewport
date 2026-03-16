import { describe, it, expect } from 'vitest';
import {
  messageToUpdate,
  stepToUpdate,
  permissionToUpdate,
} from '../../src/server/message-normalizers.js';
import type { SessionMessage, Step, PermissionRequest } from '../../src/core/types.js';

describe('messageToUpdate', () => {
  it('normalizes agent_message', () => {
    const msg: SessionMessage = {
      type: 'agent_message',
      text: 'Hello',
      messageId: 'm1',
      timestamp: 1000,
    };
    expect(messageToUpdate(msg)).toEqual({
      updateType: 'agent-message',
      messageId: 'm1',
      text: 'Hello',
      timestamp: 1000,
    });
  });

  it('normalizes agent_message_chunk', () => {
    const msg: SessionMessage = {
      type: 'agent_message_chunk',
      text: 'partial',
      messageId: 'm2',
      timestamp: 2000,
    };
    expect(messageToUpdate(msg)).toEqual({
      updateType: 'agent-message-chunk',
      messageId: 'm2',
      text: 'partial',
      timestamp: 2000,
    });
  });

  it('normalizes agent_thought_chunk', () => {
    const msg: SessionMessage = {
      type: 'agent_thought_chunk',
      text: 'thinking...',
      messageId: 'm3',
      timestamp: 3000,
    };
    expect(messageToUpdate(msg)).toEqual({
      updateType: 'agent-thought-chunk',
      messageId: 'm3',
      text: 'thinking...',
      timestamp: 3000,
    });
  });

  it('normalizes user_message', () => {
    const msg: SessionMessage = {
      type: 'user_message',
      text: 'Fix the bug',
      messageId: 'm4',
      timestamp: 4000,
    };
    expect(messageToUpdate(msg)).toEqual({
      updateType: 'user-message',
      messageId: 'm4',
      text: 'Fix the bug',
      timestamp: 4000,
    });
  });

  it('normalizes tool_call', () => {
    const msg: SessionMessage = {
      type: 'tool_call',
      toolCallId: 'tc-1',
      toolName: 'Edit',
      title: 'Edit file',
      input: { file_path: '/test.ts' },
      status: 'in_progress',
      timestamp: 5000,
    };
    const result = messageToUpdate(msg);
    expect(result.updateType).toBe('tool-call');
    expect(result.toolCallId).toBe('tc-1');
    expect(result.toolName).toBe('Edit');
    expect(result.title).toBe('Edit file');
    expect(result.input).toEqual({ file_path: '/test.ts' });
    expect(result.status).toBe('in_progress');
  });

  it('normalizes tool_call_update', () => {
    const msg: SessionMessage = {
      type: 'tool_call_update',
      toolCallId: 'tc-1',
      toolName: 'Edit',
      status: 'completed',
      title: 'Edit done',
      output: 'File edited',
      timestamp: 6000,
    };
    expect(messageToUpdate(msg)).toEqual({
      updateType: 'tool-call-update',
      toolCallId: 'tc-1',
      status: 'completed',
      title: 'Edit done',
      output: 'File edited',
      timestamp: 6000,
    });
  });

  it('normalizes token_usage', () => {
    const msg: SessionMessage = {
      type: 'token_usage',
      inputTokens: 100,
      outputTokens: 50,
      totalCostUsd: 0.01,
      timestamp: 7000,
    };
    expect(messageToUpdate(msg)).toEqual({
      updateType: 'token-usage',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      timestamp: 7000,
    });
  });

  it('normalizes system_status', () => {
    const msg: SessionMessage = {
      type: 'system_status',
      status: 'initialized',
      sessionId: 's1',
      timestamp: 8000,
    };
    expect(messageToUpdate(msg)).toEqual({
      updateType: 'system-status',
      status: 'initialized',
      timestamp: 8000,
    });
  });
});

describe('stepToUpdate', () => {
  it('maps all step fields', () => {
    const step: Step = {
      step: 3,
      sha: 'abc1234',
      type: 'tool_call_update',
      toolName: 'Edit',
      description: 'Edit completed: src/foo.ts',
      timestamp: 9000,
    };
    expect(stepToUpdate(step)).toEqual({
      updateType: 'step-committed',
      step: 3,
      sha: 'abc1234',
      toolName: 'Edit',
      description: 'Edit completed: src/foo.ts',
      timestamp: 9000,
    });
  });

  it('handles null sha', () => {
    const step: Step = {
      step: 1,
      sha: null,
      type: 'tool_call',
      description: 'pending',
      timestamp: 1000,
    };
    expect(stepToUpdate(step).sha).toBeNull();
  });
});

describe('permissionToUpdate', () => {
  it('maps all permission request fields', () => {
    const request: PermissionRequest = {
      requestId: 'pr-1',
      toolName: 'Bash',
      description: 'Run shell command',
      input: { command: 'ls' },
    };
    const result = permissionToUpdate(request);
    expect(result.updateType).toBe('permission-request');
    expect(result.requestId).toBe('pr-1');
    expect(result.toolName).toBe('Bash');
    expect(result.description).toBe('Run shell command');
    expect(result.input).toEqual({ command: 'ls' });
    expect(result.timestamp).toBeTypeOf('number');
  });

  it('handles permission request without input', () => {
    const request: PermissionRequest = {
      requestId: 'pr-2',
      toolName: 'Read',
      description: 'Read file',
    };
    const result = permissionToUpdate(request);
    expect(result.input).toBeUndefined();
  });
});
