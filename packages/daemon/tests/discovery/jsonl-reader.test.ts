import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseJSONLEntry,
  encodeProjectDir,
  decodeProjectDir,
  listProjectSessions,
  readRichSessionMessagesTailFromFile,
} from '../../src/discovery/jsonl-reader.js';

// ---------------------------------------------------------------------------
// encodeProjectDir
// ---------------------------------------------------------------------------

describe('encodeProjectDir', () => {
  it('encodes absolute path', () => {
    expect(encodeProjectDir('/Users/dev/myapp')).toBe('-Users-dev-myapp');
  });

  it('encodes path with trailing slash via resolve', () => {
    // path.resolve strips trailing slash
    expect(encodeProjectDir('/Users/dev/myapp/')).toBe('-Users-dev-myapp');
  });

  it('encodes root path', () => {
    expect(encodeProjectDir('/')).toBe('-');
  });

  it('escapes hyphens so encoding is reversible', () => {
    expect(encodeProjectDir('/Users/dev-user/my-project')).toBe('-Users-dev--user-my--project');
  });
});

describe('decodeProjectDir', () => {
  it('decodes escaped hyphens back to path hyphens', () => {
    expect(decodeProjectDir('-Users-dev--user-my--project')).toBe('/Users/dev-user/my-project');
  });

  it('round-trips encoded absolute path', () => {
    const original = '/Users/dev-user/work-tree';
    expect(decodeProjectDir(encodeProjectDir(original))).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// parseJSONLEntry
// ---------------------------------------------------------------------------

describe('parseJSONLEntry', () => {
  it('returns empty for null', () => {
    expect(parseJSONLEntry(null)).toEqual([]);
  });

  it('returns empty for non-object', () => {
    expect(parseJSONLEntry('string')).toEqual([]);
    expect(parseJSONLEntry(42)).toEqual([]);
    expect(parseJSONLEntry(true)).toEqual([]);
  });

  it('returns empty for non-user/assistant type', () => {
    expect(parseJSONLEntry({ type: 'progress', data: {} })).toEqual([]);
    expect(parseJSONLEntry({ type: 'system', data: {} })).toEqual([]);
    expect(parseJSONLEntry({ type: 'file-history-snapshot' })).toEqual([]);
  });

  it('returns empty for entry without message', () => {
    expect(parseJSONLEntry({ type: 'user' })).toEqual([]);
    expect(parseJSONLEntry({ type: 'assistant' })).toEqual([]);
  });

  it('parses string content', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'u1',
      message: { content: 'Hello world' },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('text');
    if (blocks[0]!.kind === 'text') {
      expect(blocks[0]!.role).toBe('user');
      expect(blocks[0]!.text).toBe('Hello world');
    }
  });

  it('skips empty string content', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'u1',
      message: { content: '' },
    };
    expect(parseJSONLEntry(entry)).toEqual([]);
  });

  it('parses array content with text block', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'a1',
      message: {
        content: [{ type: 'text', text: 'Here is the answer' }],
      },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('text');
    if (blocks[0]!.kind === 'text') {
      expect(blocks[0]!.text).toBe('Here is the answer');
      expect(blocks[0]!.role).toBe('assistant');
    }
  });

  it('parses tool_use block', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'a2',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'Edit',
            input: { file_path: '/test.ts' },
          },
        ],
      },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('tool_use');
    if (blocks[0]!.kind === 'tool_use') {
      expect(blocks[0]!.toolName).toBe('Edit');
      expect(blocks[0]!.toolId).toBe('tu-1');
      expect(blocks[0]!.input).toEqual({ file_path: '/test.ts' });
    }
  });

  it('parses tool_result block', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'u2',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: 'File edited successfully',
            is_error: false,
          },
        ],
      },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('tool_result');
    if (blocks[0]!.kind === 'tool_result') {
      expect(blocks[0]!.toolId).toBe('tu-1');
      expect(blocks[0]!.output).toBe('File edited successfully');
      expect(blocks[0]!.isError).toBe(false);
    }
  });

  it('parses tool_result with error flag', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'u3',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-2',
            content: 'Command failed',
            is_error: true,
          },
        ],
      },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    if (blocks[0]!.kind === 'tool_result') {
      expect(blocks[0]!.isError).toBe(true);
    }
  });

  it('parses thinking block', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'a3',
      message: {
        content: [{ type: 'thinking', thinking: 'Let me analyze the code...' }],
      },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('thinking');
    if (blocks[0]!.kind === 'thinking') {
      expect(blocks[0]!.text).toBe('Let me analyze the code...');
    }
  });

  it('parses mixed content (text + tool_use + thinking)', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'a4',
      message: {
        content: [
          { type: 'thinking', thinking: 'Hmm...' },
          { type: 'text', text: 'I will edit the file' },
          { type: 'tool_use', id: 'tu-3', name: 'Edit', input: {} },
        ],
      },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.kind).toBe('thinking');
    expect(blocks[1]!.kind).toBe('text');
    expect(blocks[2]!.kind).toBe('tool_use');
  });

  it('skips empty text blocks', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'a5',
      message: {
        content: [{ type: 'text', text: '' }],
      },
    };
    expect(parseJSONLEntry(entry)).toEqual([]);
  });

  it('handles string items in content array', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'u4',
      message: { content: ['Hello', 'World'] },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.kind).toBe('text');
    expect(blocks[1]!.kind).toBe('text');
  });

  it('skips empty strings in content array', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'u5',
      message: { content: ['', ''] },
    };
    expect(parseJSONLEntry(entry)).toEqual([]);
  });

  it('returns empty for non-array, non-string content', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'u6',
      message: { content: 42 },
    };
    expect(parseJSONLEntry(entry)).toEqual([]);
  });

  it('handles tool_use with null input gracefully', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'a6',
      message: {
        content: [{ type: 'tool_use', id: 'tu-4', name: 'Read', input: null }],
      },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    if (blocks[0]!.kind === 'tool_use') {
      expect(blocks[0]!.input).toEqual({});
    }
  });

  it('handles tool_result with array content', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'u7',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-5',
            content: [
              { type: 'text', text: 'line1' },
              { type: 'text', text: 'line2' },
            ],
          },
        ],
      },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    if (blocks[0]!.kind === 'tool_result') {
      expect(blocks[0]!.output).toBe('line1\nline2');
    }
  });

  it('skips null/undefined content blocks in array', () => {
    const entry = {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'a7',
      message: { content: [null, undefined, { type: 'text', text: 'valid' }] },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('text');
  });

  it('uses default timestamp when missing', () => {
    const entry = {
      type: 'user',
      uuid: 'u8',
      message: { content: 'Hello' },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.ts).toBeTruthy();
  });

  it('uses default uuid when missing', () => {
    const entry = {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: { content: 'Hello' },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.uuid).toBe('');
  });

  it('parses Codex response_item message entries', () => {
    const entry = {
      timestamp: '2026-03-02T17:07:37.198Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'assistant output' }],
      },
    };
    const blocks = parseJSONLEntry(entry);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('text');
    if (blocks[0]!.kind === 'text') {
      expect(blocks[0]!.role).toBe('assistant');
      expect(blocks[0]!.text).toBe('assistant output');
    }
  });

  it('parses Codex function_call and function_call_output entries', () => {
    const callBlocks = parseJSONLEntry({
      timestamp: '2026-03-02T17:07:40.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_123',
        arguments: '{"cmd":"pwd"}',
      },
    });
    expect(callBlocks).toHaveLength(1);
    expect(callBlocks[0]!.kind).toBe('tool_use');
    if (callBlocks[0]!.kind === 'tool_use') {
      expect(callBlocks[0]!.toolId).toBe('call_123');
      expect(callBlocks[0]!.toolName).toBe('exec_command');
      expect(callBlocks[0]!.input).toEqual({ cmd: 'pwd' });
    }

    const outputBlocks = parseJSONLEntry({
      timestamp: '2026-03-02T17:07:41.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'cwd output',
      },
    });
    expect(outputBlocks).toHaveLength(1);
    expect(outputBlocks[0]!.kind).toBe('tool_result');
    if (outputBlocks[0]!.kind === 'tool_result') {
      expect(outputBlocks[0]!.toolId).toBe('call_123');
      expect(outputBlocks[0]!.output).toBe('cwd output');
      expect(outputBlocks[0]!.isError).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// readRichSessionMessagesTailFromFile
// ---------------------------------------------------------------------------

describe('readRichSessionMessagesTailFromFile', () => {
  it('reads newest rich messages in chronological order from the file tail', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-jsonl-tail-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      await fs.writeFile(
        filePath,
        [
          jsonlMessage('user', 'oldest'),
          JSON.stringify({ type: 'system', timestamp: '2026-01-01T00:00:01Z' }),
          jsonlMessage('assistant', 'middle'),
          jsonlMessage('user', 'newest'),
        ].join('\n'),
        'utf-8',
      );

      const blocks = await readRichSessionMessagesTailFromFile(filePath, 2, { chunkSize: 19 });
      expect(blocks.map((block) => (block.kind === 'text' ? block.text : block.kind))).toEqual([
        'middle',
        'newest',
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('handles JSON lines split across tiny backwards chunks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-jsonl-tail-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      await fs.writeFile(
        filePath,
        [
          jsonlMessage('user', 'first split-safe message'),
          jsonlMessage('assistant', 'second split-safe message'),
        ].join('\n'),
        'utf-8',
      );

      const blocks = await readRichSessionMessagesTailFromFile(filePath, 2, { chunkSize: 7 });
      expect(blocks.map((block) => (block.kind === 'text' ? block.text : block.kind))).toEqual([
        'first split-safe message',
        'second split-safe message',
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('stops at the configured tail scan budget instead of reading unbounded history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-jsonl-tail-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      await fs.writeFile(
        filePath,
        [
          jsonlMessage('user', 'outside the scan budget'),
          ...Array.from({ length: 100 }, (_, index) =>
            JSON.stringify({
              type: 'system',
              timestamp: `2026-01-01T00:00:${index}Z`,
              pad: 'x'.repeat(128),
            }),
          ),
        ].join('\n'),
        'utf-8',
      );

      const blocks = await readRichSessionMessagesTailFromFile(filePath, 5, {
        chunkSize: 64,
        maxBytes: 512,
      });
      expect(blocks).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips oversized tail lines and still returns earlier usable messages', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-jsonl-tail-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      await fs.writeFile(
        filePath,
        [
          jsonlMessage('assistant', 'usable before huge line'),
          jsonlMessage('user', 'x'.repeat(2_048)),
        ].join('\n'),
        'utf-8',
      );

      const blocks = await readRichSessionMessagesTailFromFile(filePath, 2, {
        chunkSize: 128,
        maxLineBytes: 1_024,
      });
      expect(blocks.map((block) => (block.kind === 'text' ? block.text : block.kind))).toEqual([
        'usable before huge line',
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function jsonlMessage(role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    type: role,
    timestamp: '2026-01-01T00:00:00Z',
    uuid: `${role}-${text.slice(0, 8)}`,
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

// ---------------------------------------------------------------------------
// listProjectSessions
// ---------------------------------------------------------------------------

describe('listProjectSessions', () => {
  it('marks session non-resumable when history contains empty user text blocks', async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-jsonl-'));
    try {
      const dirName = '-Users-test-project';
      const projectDir = path.join(basePath, dirName);
      await fs.mkdir(projectDir, { recursive: true });
      const sessionId = 'sid-poisoned';
      const filePath = path.join(projectDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        filePath,
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-03-02T16:00:00.000Z',
            message: { content: [{ type: 'text', text: 'hello' }] },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-03-02T16:00:01.000Z',
            message: { content: [{ type: 'text', text: 'hi' }] },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-03-02T16:00:02.000Z',
            message: { content: [{ type: 'text', text: '' }] },
          }),
        ].join('\n'),
        'utf-8',
      );

      const sessions = await listProjectSessions(dirName, basePath);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe(sessionId);
      expect(sessions[0]?.resumable).toBe(false);
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });

  it('keeps session resumable when no poison patterns are present', async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-jsonl-'));
    try {
      const dirName = '-Users-test-project-healthy';
      const projectDir = path.join(basePath, dirName);
      await fs.mkdir(projectDir, { recursive: true });
      const sessionId = 'sid-healthy';
      const filePath = path.join(projectDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        filePath,
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-03-02T16:10:00.000Z',
            message: { content: [{ type: 'text', text: 'hello' }] },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-03-02T16:10:01.000Z',
            message: { content: [{ type: 'text', text: 'all good' }] },
          }),
        ].join('\n'),
        'utf-8',
      );

      const sessions = await listProjectSessions(dirName, basePath);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe(sessionId);
      expect(sessions[0]?.resumable).toBe(true);
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });
});
