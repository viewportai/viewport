import { describe, expect, it } from 'vitest';
import { evaluateTriggerRule, isTriggerSkipReason } from '../../src/workflows/trigger-rule.js';
import type { WorkflowNodeRunState, WorkflowNodeStatus } from '../../src/workflows/types.js';

function makeParents(statuses: WorkflowNodeStatus[]): WorkflowNodeRunState[] {
  return statuses.map((status, index) => ({
    id: `parent-${index}`,
    type: 'shell',
    status,
  }));
}

describe('trigger-rule', () => {
  it('all_success readies only when every parent completed', () => {
    expect(evaluateTriggerRule('all_success', makeParents(['completed', 'completed'])).ready).toBe(
      true,
    );
    const skipped = evaluateTriggerRule('all_success', makeParents(['completed', 'failed']));
    expect(skipped.ready).toBe(false);
    expect(isTriggerSkipReason(skipped.reason)).toBe(true);
  });

  it('all_done readies on any terminal mix', () => {
    expect(
      evaluateTriggerRule('all_done', makeParents(['completed', 'failed', 'skipped'])).ready,
    ).toBe(true);
    expect(evaluateTriggerRule('all_done', makeParents(['completed', 'running'])).ready).toBe(
      false,
    );
  });

  it('one_success readies when at least one parent completed', () => {
    expect(evaluateTriggerRule('one_success', makeParents(['failed', 'completed'])).ready).toBe(
      true,
    );
    expect(evaluateTriggerRule('one_success', makeParents(['failed', 'skipped'])).ready).toBe(
      false,
    );
  });

  it('defaults to all_success when no rule is set', () => {
    expect(evaluateTriggerRule(undefined, makeParents(['completed'])).ready).toBe(true);
    expect(evaluateTriggerRule(undefined, makeParents(['failed'])).ready).toBe(false);
  });

  it('readies a node with no parents regardless of rule', () => {
    expect(evaluateTriggerRule('all_success', []).ready).toBe(true);
    expect(evaluateTriggerRule('all_done', []).ready).toBe(true);
    expect(evaluateTriggerRule('one_success', []).ready).toBe(true);
  });
});
