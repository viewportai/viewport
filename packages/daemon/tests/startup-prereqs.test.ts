import { describe, expect, it } from 'vitest';
import { detectPrereqIssues } from '../src/startup-prereqs.js';

describe('startup prerequisites', () => {
  it('flags codex sdk when codex is preferred and sdk is missing', () => {
    const issues = detectPrereqIssues({
      preferredAgents: new Set(['codex']),
      hasClaudeSessions: false,
      hasCodexSessions: false,
      claudeSdkInstalled: true,
      codexSdkInstalled: false,
      geminiCliInstalled: true,
    });

    expect(issues.map((i) => i.id)).toContain('codex-sdk');
  });

  it('flags claude sdk when claude sessions exist and sdk is missing', () => {
    const issues = detectPrereqIssues({
      preferredAgents: new Set(),
      hasClaudeSessions: true,
      hasCodexSessions: false,
      claudeSdkInstalled: false,
      codexSdkInstalled: true,
      geminiCliInstalled: true,
    });

    expect(issues.map((i) => i.id)).toContain('claude-sdk');
  });

  it('flags gemini cli only when gemini is preferred and cli is missing', () => {
    const issues = detectPrereqIssues({
      preferredAgents: new Set(['gemini']),
      hasClaudeSessions: false,
      hasCodexSessions: false,
      claudeSdkInstalled: true,
      codexSdkInstalled: true,
      geminiCliInstalled: false,
    });
    expect(issues.map((i) => i.id)).toContain('gemini-cli');
  });

  it('does not flag gemini cli when gemini is not preferred', () => {
    const issues = detectPrereqIssues({
      preferredAgents: new Set(['claude']),
      hasClaudeSessions: false,
      hasCodexSessions: false,
      claudeSdkInstalled: true,
      codexSdkInstalled: true,
      geminiCliInstalled: false,
    });
    expect(issues.map((i) => i.id)).not.toContain('gemini-cli');
  });
});
