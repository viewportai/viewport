import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { parseListenTarget } from '../../src/cli/listen-target.js';

describe('listen target parser', () => {
  it('parses host:port targets', () => {
    expect(parseListenTarget('127.0.0.1:7070')).toEqual({
      type: 'tcp',
      host: '127.0.0.1',
      port: 7070,
      listen: '127.0.0.1:7070',
    });
  });

  it('parses bare port using default host', () => {
    expect(parseListenTarget('8080', '0.0.0.0')).toEqual({
      type: 'tcp',
      host: '0.0.0.0',
      port: 8080,
      listen: '0.0.0.0:8080',
    });
  });

  it('parses unix socket targets', () => {
    const parsed = parseListenTarget('./tmp/daemon.sock');
    expect(parsed.type).toBe('socket');
    expect(parsed.path).toBe(path.resolve('./tmp/daemon.sock'));
    expect(parsed.listen).toBe(`unix://${path.resolve('./tmp/daemon.sock')}`);
  });

  it('rejects malformed listen targets', () => {
    expect(() => parseListenTarget('')).toThrow(/required/i);
    expect(() => parseListenTarget('abc')).toThrow(/invalid/i);
    expect(() => parseListenTarget('127.0.0.1:99999')).toThrow(/invalid/i);
  });
});
