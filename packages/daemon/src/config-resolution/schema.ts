import { z } from 'zod';

const ResourceRefSchema = z.union([
  z.string().trim().min(1).max(512),
  z
    .object({
      id: z.string().trim().min(1).max(512),
      required: z.boolean().optional(),
    })
    .strict(),
]);

const ProviderCapabilitySchema = z.enum(['search', 'get', 'propose', 'write_approved']);
const ProviderPrivacySchema = z.enum([
  'local_only',
  'control_plane_blind',
  'third_party_terms',
  'customer_hosted',
  'unknown',
]);
const ProviderKindSchema = z.enum([
  'repo-docs',
  'viewport-vault',
  'notebooklm',
  'glean',
  'custom-cli',
  'custom-mcp',
]);
const SizeBudgetSchema = z.union([
  z.number().int().min(1024).max(1_000_000),
  z
    .string()
    .trim()
    .regex(/^\d+(b|kb|mb)?$/i, 'Use bytes, kb, or mb, for example 64000 or 64kb.'),
]);
const CredentialRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/,
    'Use an opaque credential handle, for example credentials/notebooklm/work.',
  );
const ALLOWED_CREDENTIAL_REF_KEYS = new Set(['credential_ref', 'credentialRef']);
const SECRET_FIELD_PATTERN =
  /(^|[_-])(auth|oauth|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|secret|password|credential|credentials)([_-]|$)/i;

const ContextProviderSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    provider: ProviderKindSchema,
    required: z.boolean().optional(),
    privacy: ProviderPrivacySchema.optional(),
    capabilities: z.array(ProviderCapabilitySchema).max(4).optional(),
    credential_ref: CredentialRefSchema.optional(),
    credentialRef: CredentialRefSchema.optional(),
    paths: z.array(z.string().trim().min(1).max(512)).max(100).optional(),
    vault: z.string().trim().min(1).max(256).optional(),
    use_when: z.string().trim().min(1).max(5000).optional(),
    useWhen: z.string().trim().min(1).max(5000).optional(),
    update_when: z.string().trim().min(1).max(5000).optional(),
    updateWhen: z.string().trim().min(1).max(5000).optional(),
    notebook: z.string().trim().min(1).max(256).optional(),
    command: z.string().trim().min(1).max(512).optional(),
  })
  .passthrough()
  .superRefine((provider, ctx) => {
    if (
      provider.credential_ref &&
      provider.credentialRef &&
      provider.credential_ref !== provider.credentialRef
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credential_ref'],
        message: 'credential_ref and credentialRef must match when both are set.',
      });
    }

    for (const fieldPath of secretFieldPaths(provider)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: fieldPath,
        message:
          'Provider credentials must use credential_ref handles. Do not commit tokens, API keys, passwords, or auth blocks in .viewport config.',
      });
    }
  });

function secretFieldPaths(
  value: unknown,
  path: Array<string | number> = [],
): Array<Array<string | number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const paths: Array<Array<string | number>> = [];
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (ALLOWED_CREDENTIAL_REF_KEYS.has(key)) continue;
    const nextPath = [...path, key];
    if (SECRET_FIELD_PATTERN.test(key)) {
      paths.push(nextPath);
      continue;
    }
    paths.push(...secretFieldPaths(nestedValue, nextPath));
  }
  return paths;
}

const ContextResolutionSchema = z
  .object({
    order: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
    size_budget: SizeBudgetSchema.optional(),
    size_budget_bytes: SizeBudgetSchema.optional(),
    strategy: z
      .enum(['rank_by_recency_then_query', 'pinned_then_recent', 'provider_order'])
      .optional(),
    propose_fallback_provider: z.string().trim().min(1).max(128).optional(),
    proposeFallbackProvider: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const WorkflowRefSchema = z.union([
  z.string().trim().min(1).max(512),
  z
    .object({
      path: z.string().trim().min(1).max(512).optional(),
      resource: z.string().trim().min(1).max(256).optional(),
      version: z.string().trim().min(1).max(64).optional(),
      digest: z.string().trim().min(1).max(256).optional(),
      required: z.boolean().optional(),
    })
    .strict()
    .refine((entry) => Boolean(entry.path) || Boolean(entry.resource), {
      message: 'Set path or resource for workflow reference.',
    }),
]);

const RiskyPathRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(128).optional(),
    path: z.string().trim().min(1).max(512),
    require: z.array(z.string().trim().min(1).max(128)).min(1).max(20),
    checks: z.array(z.string().trim().min(1).max(512)).max(20).optional(),
  })
  .strict();

export const ViewportConfigSchema = z
  .object({
    $schema: z.string().url().optional(),
    version: z.literal(1).optional().default(1),
    name: z.string().trim().min(1).max(256).optional(),
    resources: z
      .object({
        contexts: z.array(ResourceRefSchema).max(100).optional(),
        workflows: z.array(ResourceRefSchema).max(100).optional(),
        plans: z.array(ResourceRefSchema).max(100).optional(),
        agentProfiles: z.array(ResourceRefSchema).max(100).optional(),
      })
      .strict()
      .optional(),
    context: z
      .object({
        providers: z.array(ContextProviderSchema).max(50).optional(),
        resolution: ContextResolutionSchema.optional(),
      })
      .strict()
      .optional(),
    workflows: z.record(z.string().trim().min(1).max(128), WorkflowRefSchema).optional(),
    approvals: z
      .object({
        risky_paths: z.array(RiskyPathRuleSchema).max(100).optional(),
        riskyPaths: z.array(RiskyPathRuleSchema).max(100).optional(),
      })
      .strict()
      .optional(),
    defaults: z
      .object({
        inboxRoute: z.string().trim().min(1).max(256).optional(),
        workflow: z.string().trim().min(1).max(256).optional(),
        visibility: z.enum(['private', 'team', 'organization']).optional(),
        context_candidate_review: z
          .enum(['single_reviewer', 'owner_auto_approve', 'manual_assign'])
          .optional(),
        contextCandidateReview: z.string().trim().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    scope: z
      .object({
        includeChildren: z.boolean().optional(),
        maxDepth: z.number().int().min(0).max(5).optional(),
        exclude: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export type ViewportConfigInput = z.infer<typeof ViewportConfigSchema>;
