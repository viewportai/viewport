import { describe, it, expect } from 'vitest';
import { NoopTracker } from '../../src/tracking/noop-tracker.js';

describe('NoopTracker', () => {
  it('setup returns the project path unchanged', async () => {
    const tracker = new NoopTracker();
    const result = await tracker.setup('test-session', '/home/me/project');
    expect(result).toBe('/home/me/project');
  });

  it('has no steps', () => {
    const tracker = new NoopTracker();
    expect(tracker.steps).toEqual([]);
  });

  it('onMessage does nothing (no throw)', () => {
    const tracker = new NoopTracker();
    expect(() => {
      tracker.onMessage({
        type: 'tool_call',
        toolCallId: 'tc1',
        toolName: 'Edit',
        title: 'Edit file',
        status: 'completed',
        timestamp: Date.now(),
      });
    }).not.toThrow();
  });

  it('rollback throws', async () => {
    const tracker = new NoopTracker();
    await expect(tracker.rollback('abc123')).rejects.toThrow('not available');
  });

  it('branchRetry throws', async () => {
    const tracker = new NoopTracker();
    await expect(tracker.branchRetry('abc123')).rejects.toThrow('not available');
  });

  it('squashMerge throws', async () => {
    const tracker = new NoopTracker();
    await expect(tracker.squashMerge('main', 'msg')).rejects.toThrow('not available');
  });

  it('teardown succeeds', async () => {
    const tracker = new NoopTracker();
    await expect(tracker.teardown()).resolves.toBeUndefined();
  });

  it('getDiff returns empty string', async () => {
    const tracker = new NoopTracker();
    expect(await tracker.getDiff('abc')).toBe('');
  });

  it('getStepDiffs returns empty array', async () => {
    const tracker = new NoopTracker();
    expect(await tracker.getStepDiffs()).toEqual([]);
  });

  it('getSummaryDiff returns empty string', async () => {
    const tracker = new NoopTracker();
    expect(await tracker.getSummaryDiff()).toBe('');
  });
});
