import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector } from '../../src/core/metrics.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  // ---------------------------------------------------------------------------
  // increment
  // ---------------------------------------------------------------------------

  it('increments a counter by 1 by default', () => {
    collector.increment('requests');
    expect(collector.snapshot().counters['requests']).toBe(1);
  });

  it('increments a counter by n', () => {
    collector.increment('bytes', 1024);
    expect(collector.snapshot().counters['bytes']).toBe(1024);
  });

  it('accumulates multiple increments', () => {
    collector.increment('requests');
    collector.increment('requests');
    collector.increment('requests', 3);
    expect(collector.snapshot().counters['requests']).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // gauge
  // ---------------------------------------------------------------------------

  it('sets a gauge value', () => {
    collector.gauge('active_sessions', 3);
    expect(collector.snapshot().gauges['active_sessions']).toBe(3);
  });

  it('overwrites previous gauge value', () => {
    collector.gauge('active_sessions', 3);
    collector.gauge('active_sessions', 5);
    expect(collector.snapshot().gauges['active_sessions']).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // snapshot
  // ---------------------------------------------------------------------------

  it('returns correct snapshot with counters and gauges', () => {
    collector.increment('requests', 10);
    collector.increment('errors', 2);
    collector.gauge('active_sessions', 3);
    collector.gauge('memory_mb', 128);

    const snap = collector.snapshot();
    expect(snap.counters).toEqual({ requests: 10, errors: 2 });
    expect(snap.gauges).toEqual({ active_sessions: 3, memory_mb: 128 });
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  it('returns empty objects when no metrics recorded', () => {
    const snap = collector.snapshot();
    expect(snap.counters).toEqual({});
    expect(snap.gauges).toEqual({});
  });

  it('returns a snapshot with a recent timestamp', () => {
    const before = Date.now();
    const snap = collector.snapshot();
    const after = Date.now();
    expect(snap.timestamp).toBeGreaterThanOrEqual(before);
    expect(snap.timestamp).toBeLessThanOrEqual(after);
  });

  // ---------------------------------------------------------------------------
  // reset
  // ---------------------------------------------------------------------------

  it('clears all counters and gauges', () => {
    collector.increment('requests', 100);
    collector.gauge('sessions', 5);

    collector.reset();

    const snap = collector.snapshot();
    expect(snap.counters).toEqual({});
    expect(snap.gauges).toEqual({});
  });
});
