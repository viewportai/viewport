import { z } from 'zod';
import { HookBaseInputSchema } from '../hooks/types.js';
import type { WorkflowInputValue } from '../workflows/types.js';

export const SessionModeBodySchema = z.object({ mode: z.enum(['detect', 'bypass']) }).strict();

export const WorktreeRollbackBodySchema = z.object({ toSha: z.string().trim().min(1) }).strict();

export const WorktreeRetryBodySchema = z.object({ fromSha: z.string().trim().min(1) }).strict();

export const WorktreeSquashBodySchema = z
  .object({
    targetBranch: z.string().trim().min(1).optional(),
    commitMessage: z.string().trim().min(1).optional(),
  })
  .strict();

export const PermissionRespondBodySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    requestId: z.string().trim().min(1),
    behavior: z.enum(['allow', 'deny']),
    message: z.string().trim().min(1).optional(),
    allowAlways: z.boolean().optional(),
  })
  .strict();

export const DirectoryRegisterBodySchema = z
  .object({
    path: z.string().trim().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const WorkflowValidateBodySchema = z
  .object({
    workflowPath: z.string().trim().min(1).optional(),
    workflowYaml: z.string().trim().min(1).max(256_000).optional(),
    workflowSourceRef: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.workflowPath || value.workflowYaml), {
    message: 'workflowPath or workflowYaml is required',
    path: ['workflowPath'],
  });

const WorkflowInputValueSchema: z.ZodType<WorkflowInputValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(WorkflowInputValueSchema),
    z.record(z.string(), WorkflowInputValueSchema),
  ]),
);

const RuntimeSecretEnvSchema = z.record(
  z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().min(1).max(128_000),
);

const RuntimeSecretFilesSchema = z.record(
  z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().min(1).max(4096),
);

const WorkflowResourceManifestBodySchema = z
  .object({
    schema: z.literal('viewport.session_resource_manifest/v1'),
    manifestDigest: z.string().trim().min(1).max(255),
  })
  .passthrough();

export const WorkflowRunBodySchema = z
  .object({
    workflowPath: z.string().trim().min(1).optional(),
    workflowYaml: z.string().trim().min(1).max(256_000).optional(),
    workflowSourceRef: z.string().trim().min(1).optional(),
    workflowContract: z
      .object({
        id: z.string().trim().min(1).max(128).optional(),
        sourceConfigPath: z.string().trim().min(1).max(4096).optional(),
        declaredPath: z.string().trim().min(1).max(4096).optional(),
        resource: z.string().trim().min(1).max(256).optional(),
        version: z.string().trim().min(1).max(64).optional(),
        declaredDigest: z.string().trim().min(1).max(256).optional(),
        status: z.enum(['verified', 'undeclared', 'digest_mismatch']),
        reason: z.string().trim().min(1).max(512).optional(),
      })
      .strict()
      .optional(),
    directoryId: z.string().trim().min(1),
    inputs: z.record(z.string(), WorkflowInputValueSchema).optional(),
    runtimeSecretEnv: RuntimeSecretEnvSchema.optional(),
    runtimeSecretFiles: RuntimeSecretFilesSchema.optional(),
    resourceId: z.string().trim().min(1).optional(),
    runtimeTargetId: z.string().trim().min(1).optional(),
    platformRunId: z.string().trim().min(1).optional(),
    rerunOfWorkflowRunId: z.string().trim().min(1).optional(),
    resourceManifest: WorkflowResourceManifestBodySchema.optional(),
    executionPolicy: z
      .object({
        mode: z.enum(['current_tree', 'isolated_worktree', 'named_branch']),
        branch: z.string().trim().min(1).max(255).optional(),
      })
      .strict()
      .optional(),
    dataCapturePolicy: z
      .object({
        transcripts: z.enum(['none', 'excerpt']),
        logs: z.enum(['metadata', 'content']),
        artifacts: z.enum(['metadata', 'local_reference']),
      })
      .strict()
      .optional(),
    initiation: z.enum(['cli', 'browser', 'agent_skill']).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.workflowPath || value.workflowYaml), {
    message: 'workflowPath or workflowYaml is required',
    path: ['workflowPath'],
  });

export const WorkflowApprovalBodySchema = z
  .object({
    approved: z.boolean(),
    decision: z.enum(['approve', 'request_changes', 'reject']).optional(),
    expectedActionDigest: z.string().trim().min(1).max(255).optional(),
    executionGrant: z
      .object({
        schema: z.string().trim().min(1).max(255).optional(),
        digest: z.string().trim().min(1).max(255),
        proposal_key: z.string().trim().min(1).max(255).optional(),
        approval_decision_key: z.string().trim().min(1).max(255).optional(),
        issued_at: z.string().trim().min(1).max(255).optional(),
      })
      .strict()
      .optional(),
    runtimeSecretEnv: RuntimeSecretEnvSchema.optional(),
    runtimeSecretFiles: RuntimeSecretFilesSchema.optional(),
    message: z.string().trim().min(1).max(2_000).optional(),
    feedback: z.record(z.string(), z.unknown()).optional(),
    actor: z
      .object({
        id: z.string().trim().min(1).max(255).optional(),
        name: z.string().trim().min(1).max(255).optional(),
        email: z.string().email().max(255).optional(),
        source: z.string().trim().min(1).max(255).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const WorkflowCancelBodySchema = z
  .object({
    message: z.string().trim().min(1).max(2_000).optional(),
    actor: z
      .object({
        id: z.string().trim().min(1).max(255).optional(),
        name: z.string().trim().min(1).max(255).optional(),
        email: z.string().email().max(255).optional(),
        source: z.string().trim().min(1).max(255).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PairRedeemBodySchema = z
  .object({
    offerId: z.string().trim().min(1),
    proof: z.string().trim().min(1),
    trustAnchor: z.string().trim().min(1),
    clientPublicKey: z.string().trim().min(1),
    clientProof: z.string().trim().min(1),
  })
  .strict();

export const PairOfferBodySchema = z
  .object({
    ttlSeconds: z.number().int().min(30).max(3600).optional(),
  })
  .strict();

export const HookBodySchema = HookBaseInputSchema.extend({
  adapter: z.string().trim().min(1).max(64).optional(),
}).passthrough();

export function invalidPayloadError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid payload';
  const field = first.path.join('.') || '<root>';
  return `Invalid payload at ${field}: ${first.message}`;
}
