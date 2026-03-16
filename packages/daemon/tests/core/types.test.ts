import { describe, it, expect } from 'vitest';
import { toToolCallDetail } from '../../src/core/types.js';

describe('toToolCallDetail', () => {
  it('maps Bash to shell', () => {
    const result = toToolCallDetail('Bash', { command: 'ls -la', cwd: '/tmp', timeout: 5000 });
    expect(result.kind).toBe('shell');
    if (result.kind === 'shell') {
      expect(result.command).toBe('ls -la');
      expect(result.cwd).toBe('/tmp');
      expect(result.timeout).toBe(5000);
    }
  });

  it('maps Bash with empty input', () => {
    const result = toToolCallDetail('Bash', {});
    expect(result.kind).toBe('shell');
    if (result.kind === 'shell') {
      expect(result.command).toBe('');
    }
  });

  it('maps Read to read', () => {
    const result = toToolCallDetail('Read', { file_path: '/test.ts', offset: 10, limit: 50 });
    expect(result.kind).toBe('read');
    if (result.kind === 'read') {
      expect(result.filePath).toBe('/test.ts');
      expect(result.offset).toBe(10);
      expect(result.limit).toBe(50);
    }
  });

  it('maps Edit to edit', () => {
    const result = toToolCallDetail('Edit', {
      file_path: '/test.ts',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    });
    expect(result.kind).toBe('edit');
    if (result.kind === 'edit') {
      expect(result.filePath).toBe('/test.ts');
      expect(result.oldString).toBe('foo');
      expect(result.newString).toBe('bar');
      expect(result.replaceAll).toBe(true);
    }
  });

  it('maps MultiEdit to edit', () => {
    const result = toToolCallDetail('MultiEdit', { file_path: '/test.ts' });
    expect(result.kind).toBe('edit');
  });

  it('maps Write to write', () => {
    const result = toToolCallDetail('Write', { file_path: '/test.ts', content: 'hello' });
    expect(result.kind).toBe('write');
    if (result.kind === 'write') {
      expect(result.filePath).toBe('/test.ts');
      expect(result.content).toBe('hello');
    }
  });

  it('maps Grep to search', () => {
    const result = toToolCallDetail('Grep', {
      pattern: 'foo',
      path: '/src',
      glob: '*.ts',
      type: 'ts',
      output_mode: 'content',
    });
    expect(result.kind).toBe('search');
    if (result.kind === 'search') {
      expect(result.pattern).toBe('foo');
      expect(result.path).toBe('/src');
      expect(result.glob).toBe('*.ts');
      expect(result.type).toBe('ts');
      expect(result.outputMode).toBe('content');
    }
  });

  it('maps Glob to glob', () => {
    const result = toToolCallDetail('Glob', { pattern: '**/*.ts', path: '/src' });
    expect(result.kind).toBe('glob');
    if (result.kind === 'glob') {
      expect(result.pattern).toBe('**/*.ts');
      expect(result.path).toBe('/src');
    }
  });

  it('maps Agent to agent', () => {
    const result = toToolCallDetail('Agent', {
      subagent_type: 'explore',
      description: 'Find files',
      prompt: 'Search for tests',
    });
    expect(result.kind).toBe('agent');
    if (result.kind === 'agent') {
      expect(result.subagentType).toBe('explore');
      expect(result.description).toBe('Find files');
      expect(result.prompt).toBe('Search for tests');
    }
  });

  it('maps Task to agent', () => {
    const result = toToolCallDetail('Task', {});
    expect(result.kind).toBe('agent');
  });

  it('maps WebSearch to web', () => {
    const result = toToolCallDetail('WebSearch', { query: 'test query' });
    expect(result.kind).toBe('web');
    if (result.kind === 'web') {
      expect(result.query).toBe('test query');
    }
  });

  it('maps WebFetch to web', () => {
    const result = toToolCallDetail('WebFetch', {
      url: 'https://example.com',
      prompt: 'Extract data',
    });
    expect(result.kind).toBe('web');
    if (result.kind === 'web') {
      expect(result.url).toBe('https://example.com');
      expect(result.prompt).toBe('Extract data');
    }
  });

  it('maps NotebookEdit to notebook', () => {
    const result = toToolCallDetail('NotebookEdit', {
      notebook_path: '/test.ipynb',
      edit_mode: 'replace',
      cell_type: 'code',
    });
    expect(result.kind).toBe('notebook');
    if (result.kind === 'notebook') {
      expect(result.notebookPath).toBe('/test.ipynb');
      expect(result.editMode).toBe('replace');
      expect(result.cellType).toBe('code');
    }
  });

  it('maps unknown tools to unknown kind', () => {
    const result = toToolCallDetail('CustomTool', { foo: 'bar' });
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.toolName).toBe('CustomTool');
      expect(result.input).toEqual({ foo: 'bar' });
    }
  });

  it('handles undefined input', () => {
    const result = toToolCallDetail('Bash');
    expect(result.kind).toBe('shell');
    if (result.kind === 'shell') {
      expect(result.command).toBe('');
    }
  });

  it('Bash without optional fields returns undefined for cwd/timeout', () => {
    const result = toToolCallDetail('Bash', { command: 'ls' });
    if (result.kind === 'shell') {
      expect(result.cwd).toBeUndefined();
      expect(result.timeout).toBeUndefined();
    }
  });

  it('Read without optional offset/limit', () => {
    const result = toToolCallDetail('Read', { file_path: '/test.ts' });
    if (result.kind === 'read') {
      expect(result.offset).toBeUndefined();
      expect(result.limit).toBeUndefined();
    }
  });

  it('Edit without optional fields', () => {
    const result = toToolCallDetail('Edit', { file_path: '/test.ts' });
    if (result.kind === 'edit') {
      expect(result.oldString).toBeUndefined();
      expect(result.newString).toBeUndefined();
      expect(result.replaceAll).toBe(false);
    }
  });

  it('Write without content', () => {
    const result = toToolCallDetail('Write', { file_path: '/test.ts' });
    if (result.kind === 'write') {
      expect(result.content).toBeUndefined();
    }
  });

  it('Grep without optional fields', () => {
    const result = toToolCallDetail('Grep', { pattern: 'foo' });
    if (result.kind === 'search') {
      expect(result.path).toBeUndefined();
      expect(result.glob).toBeUndefined();
      expect(result.type).toBeUndefined();
      expect(result.outputMode).toBeUndefined();
    }
  });

  it('Glob without optional path', () => {
    const result = toToolCallDetail('Glob', { pattern: '*.ts' });
    if (result.kind === 'glob') {
      expect(result.path).toBeUndefined();
    }
  });

  it('Agent without optional fields', () => {
    const result = toToolCallDetail('Agent', {});
    if (result.kind === 'agent') {
      expect(result.subagentType).toBeUndefined();
      expect(result.description).toBeUndefined();
      expect(result.prompt).toBeUndefined();
    }
  });

  it('WebFetch without optional fields', () => {
    const result = toToolCallDetail('WebFetch', {});
    if (result.kind === 'web') {
      expect(result.url).toBeUndefined();
      expect(result.prompt).toBeUndefined();
    }
  });

  it('WebSearch without query', () => {
    const result = toToolCallDetail('WebSearch', {});
    if (result.kind === 'web') {
      expect(result.query).toBeUndefined();
    }
  });

  it('NotebookEdit without optional fields', () => {
    const result = toToolCallDetail('NotebookEdit', {});
    if (result.kind === 'notebook') {
      expect(result.notebookPath).toBeUndefined();
      expect(result.editMode).toBeUndefined();
      expect(result.cellType).toBeUndefined();
    }
  });

  it('unknown tool without input', () => {
    const result = toToolCallDetail('CustomTool');
    if (result.kind === 'unknown') {
      expect(result.input).toBeUndefined();
    }
  });
});
