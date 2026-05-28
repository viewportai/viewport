import { z } from 'zod';
import type { WorkflowInputValue } from './run-types.js';

export const InputValueSchema: z.ZodType<WorkflowInputValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(InputValueSchema),
    z.record(z.string(), InputValueSchema),
  ]),
);

export const InputDefinitionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'json']),
    required: z.boolean().optional(),
    default: InputValueSchema.optional(),
    description: z.string().optional(),
  })
  .strict();

export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-zA-Z0-9._/-]+$/);

export const OutputDefinitionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'json', 'file', 'artifact']),
    requirement: z.enum(['required', 'optional', 'unsupported']).optional(),
    description: z.string().optional(),
    extract: z.string().trim().min(1).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const ArtifactDefinitionSchema = z
  .object({
    path: z.string().trim().min(1),
    type: z.enum(['file', 'directory', 'patch', 'report', 'log']).optional(),
    description: z.string().optional(),
  })
  .strict();

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    backoffSeconds: z.number().int().min(0).max(86_400).optional(),
    transient: z.array(z.string().min(1)).optional(),
    fatal: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const NodePolicySchema = z
  .object({
    onFailure: z.enum(['halt', 'continue', 'skip_dependents']).optional(),
    approvalRequired: z.boolean().optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export const EnvValueSchema = z
  .object({
    value: z.string().optional(),
    secret: identifierSchema.optional(),
  })
  .strict()
  .refine((entry) => Boolean(entry.value) !== Boolean(entry.secret), {
    message: 'Set exactly one of value or secret.',
  });

export const RequiresSchema = z
  .object({
    agents: z.array(z.string().trim().min(1)).optional(),
    tools: z.array(z.string().trim().min(1)).optional(),
    integrations: z.array(z.string().trim().min(1)).optional(),
    secrets: z.array(identifierSchema).optional(),
  })
  .strict();

export const ContextReferenceSchema = z
  .object({
    ref: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1).optional(),
    package: z.string().trim().min(1).optional(),
    artifact: z.string().trim().min(1).optional(),
    as: identifierSchema.optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    refresh: z.enum(['manual', 'before_run', 'on_demand']).optional(),
    max_items: z.number().int().positive().max(100).optional(),
    maxItems: z.number().int().positive().max(100).optional(),
  })
  .strict()
  .refine((entry) => Boolean(entry.ref ?? entry.source ?? entry.package ?? entry.artifact), {
    message: 'Set one of ref, source, package, or artifact.',
  });

export const ContextSchema = z.array(z.union([z.string().trim().min(1), ContextReferenceSchema]));

export const ContextWriteTargetSchema = z.union([
  z.string().trim().min(1),
  z
    .object({
      ref: z.string().trim().min(1).optional(),
      kind: z
        .enum(['team_memory', 'org_rule', 'repo_pr', 'context_vault', 'vector_store', 'external'])
        .optional(),
      path: z.string().trim().min(1).optional(),
      collection: z.string().trim().min(1).optional(),
      provider: z.string().trim().min(1).optional(),
      name: z.string().trim().min(1).optional(),
      approval: z.enum(['required', 'optional', 'not_required']).optional(),
    })
    .strict()
    .refine((entry) => Boolean(entry.ref ?? entry.kind ?? entry.path ?? entry.collection), {
      message: 'Set ref, kind, path, or collection for context write target.',
    }),
]);

export const NodeContextEnvelopeSchema = z
  .object({
    include: ContextSchema.optional(),
    exclude: ContextSchema.optional(),
    max_items: z.number().int().positive().max(100).optional(),
    maxItems: z.number().int().positive().max(100).optional(),
    query: z.string().trim().min(1).optional(),
    write_targets: z.array(ContextWriteTargetSchema).optional(),
    writeTargets: z.array(ContextWriteTargetSchema).optional(),
    allow_expansion: z.boolean().optional(),
    allowExpansion: z.boolean().optional(),
  })
  .strict();

export const WorkflowContextDefaultsSchema = z
  .object({
    sources: ContextSchema.optional(),
    update_targets: z.array(ContextWriteTargetSchema).optional(),
    updateTargets: z.array(ContextWriteTargetSchema).optional(),
  })
  .strict()
  .refine(
    (entry) =>
      Boolean(entry.sources?.length || entry.update_targets?.length || entry.updateTargets?.length),
    {
      message: 'Set sources or update_targets for workflow context defaults.',
    },
  );

export const WorkflowContextDefinitionSchema = z.union([
  ContextSchema,
  WorkflowContextDefaultsSchema,
]);
