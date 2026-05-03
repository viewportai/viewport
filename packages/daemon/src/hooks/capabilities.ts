export const HOOK_CAPABILITIES = [
  'plan.explicit_payload',
  'plan.pre_execution_blocking',
  'plan.post_render_revision',
  'plan.tool_submit',
  'plan.agent_role_gating',
  'permission.blocking',
  'message.annotation',
  'diff.annotation',
  'external_annotations',
  'feedback.approve',
  'feedback.reject',
  'feedback.approve_with_notes',
  'feedback.structured_json',
  'feedback.plaintext_only',
  'feedback.stop_continuation',
] as const;

export type HookCapability = (typeof HOOK_CAPABILITIES)[number];

export interface HookAdapterCapability {
  capability: HookCapability;
  supported: boolean;
  note: string;
}

export interface HookAdapterCapabilityProfile {
  adapter: string;
  displayName: string;
  planBoundary: 'pre_execution' | 'post_render' | 'tool_submit' | 'explicit_only' | 'unknown';
  capabilities: HookAdapterCapability[];
}

const profiles: HookAdapterCapabilityProfile[] = [
  {
    adapter: 'claude',
    displayName: 'Claude Code',
    planBoundary: 'pre_execution',
    capabilities: [
      supported('plan.explicit_payload', 'Can receive explicit PlanProposed payloads.'),
      supported(
        'plan.pre_execution_blocking',
        'Can gate ExitPlanMode through PermissionRequest before implementation proceeds.',
      ),
      supported('permission.blocking', 'PermissionRequest hooks can block for a decision.'),
      supported('feedback.approve', 'Approval can return a provider-specific allow decision.'),
      supported('feedback.reject', 'Rejection can return a provider-specific deny reason.'),
      supported(
        'feedback.approve_with_notes',
        'Notes can be returned as normalized feedback, then serialized for the hook edge.',
      ),
      supported('feedback.structured_json', 'Hook output can be JSON.'),
      unsupported(
        'plan.post_render_revision',
        'Claude has a stronger pre-execution plan boundary; post-render extraction is fallback only.',
      ),
      unsupported('plan.tool_submit', 'Claude does not expose an OpenCode-style submit_plan tool.'),
    ],
  },
  {
    adapter: 'codex',
    displayName: 'Codex',
    planBoundary: 'post_render',
    capabilities: [
      supported('plan.explicit_payload', 'Can receive explicit PlanProposed payloads.'),
      supported(
        'plan.post_render_revision',
        'Can review an explicitly marked plan from Stop hook output and ask Codex to revise.',
      ),
      supported(
        'feedback.stop_continuation',
        'Rejected plans can be returned as Stop-hook continuation feedback.',
      ),
      supported('feedback.reject', 'Rejection can return actionable continuation feedback.'),
      supported('feedback.structured_json', 'Hook wrappers can exchange normalized JSON.'),
      unsupported(
        'plan.pre_execution_blocking',
        'Codex does not currently expose a native pre-implementation ExitPlanMode equivalent.',
      ),
      unsupported('permission.blocking', 'Codex hook permission semantics are not uniform here.'),
      unsupported('plan.tool_submit', 'Codex does not expose an OpenCode-style submit_plan tool.'),
    ],
  },
  {
    adapter: 'opencode',
    displayName: 'OpenCode',
    planBoundary: 'tool_submit',
    capabilities: [
      supported('plan.explicit_payload', 'Can receive explicit PlanProposed payloads.'),
      supported('plan.tool_submit', 'Can use a submit_plan-style tool boundary.'),
      supported(
        'plan.agent_role_gating',
        'Planning agents and build agents can be gated separately.',
      ),
      supported('feedback.approve', 'Tool response can communicate approval.'),
      supported('feedback.reject', 'Tool response can communicate requested changes.'),
      supported('feedback.structured_json', 'Tool wrappers can exchange normalized JSON.'),
      unsupported(
        'plan.pre_execution_blocking',
        'OpenCode plan review is best modeled as a tool-submit boundary, not Claude ExitPlanMode.',
      ),
      unsupported(
        'plan.post_render_revision',
        'OpenCode does not need post-render extraction when submit_plan is available.',
      ),
    ],
  },
  {
    adapter: 'generic',
    displayName: 'Generic hook adapter',
    planBoundary: 'explicit_only',
    capabilities: [
      supported('plan.explicit_payload', 'Can receive explicit PlanProposed payloads.'),
      supported('feedback.plaintext_only', 'Can fall back to plaintext feedback.'),
      unsupported(
        'plan.pre_execution_blocking',
        'No provider-native blocking plan boundary declared.',
      ),
      unsupported(
        'plan.post_render_revision',
        'No provider-native post-render revision hook declared.',
      ),
      unsupported('permission.blocking', 'No provider-native permission hook declared.'),
      unsupported(
        'feedback.structured_json',
        'Structured output requires an adapter-specific wrapper.',
      ),
    ],
  },
];

function supported(capability: HookCapability, note: string): HookAdapterCapability {
  return { capability, supported: true, note };
}

function unsupported(capability: HookCapability, note: string): HookAdapterCapability {
  return { capability, supported: false, note };
}

export function listHookAdapterCapabilities(): HookAdapterCapabilityProfile[] {
  return profiles.map(cloneProfile);
}

export function getHookAdapterCapabilities(adapter: string): HookAdapterCapabilityProfile {
  const normalized = normalizeAdapter(adapter);
  const profile = profiles.find((candidate) => candidate.adapter === normalized) ?? profiles.at(-1);
  if (!profile) throw new Error('Hook capability registry is empty.');
  return cloneProfile(profile);
}

export function hookAdapterSupports(adapter: string, capability: HookCapability): boolean {
  return getHookAdapterCapabilities(adapter).capabilities.some(
    (entry) => entry.capability === capability && entry.supported,
  );
}

function normalizeAdapter(adapter: string): string {
  const normalized = adapter.trim().toLowerCase();
  if (['claude-code', 'claude_code'].includes(normalized)) return 'claude';
  if (['open-code', 'open_code'].includes(normalized)) return 'opencode';
  if (!normalized) return 'generic';
  return normalized;
}

function cloneProfile(profile: HookAdapterCapabilityProfile): HookAdapterCapabilityProfile {
  return {
    ...profile,
    capabilities: profile.capabilities.map((capability) => ({ ...capability })),
  };
}
