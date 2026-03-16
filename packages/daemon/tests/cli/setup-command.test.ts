import { describe, expect, it } from 'vitest';
import {
  applySetupFlagOverrides,
  parseLingerValue,
  recommendedSetupPlan,
  resolveInstallUserForLinger,
} from '../../src/cli/setup-command.js';

describe('setup command planning', () => {
  it('returns recommended defaults', () => {
    expect(recommendedSetupPlan()).toEqual({
      recommended: true,
      installService: true,
      installPrereqs: true,
      installHooks: true,
    });
  });

  it('applies power-user no-* overrides', () => {
    const plan = applySetupFlagOverrides(recommendedSetupPlan(), [
      'setup',
      '--no-service',
      '--no-prereqs',
      '--no-hooks',
    ]);
    expect(plan.installService).toBe(false);
    expect(plan.installPrereqs).toBe(false);
    expect(plan.installHooks).toBe(false);
  });

  it('resolves install user for linger checks', () => {
    expect(resolveInstallUserForLinger({ SUDO_USER: 'rooted', USER: 'regular' })).toBe('rooted');
    expect(resolveInstallUserForLinger({ USER: 'regular' })).toBe('regular');
    expect(resolveInstallUserForLinger({})).toBeNull();
  });

  it('parses loginctl linger values', () => {
    expect(parseLingerValue('yes\n')).toBe(true);
    expect(parseLingerValue('no')).toBe(false);
    expect(parseLingerValue('unknown')).toBeNull();
  });
});
