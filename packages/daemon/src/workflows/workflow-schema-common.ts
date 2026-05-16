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
    description: z.string().optional(),
    extract: z.string().trim().min(1).optional(),
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
    ref: z.string().trim().min(1),
    as: identifierSchema.optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    refresh: z.enum(['manual', 'before_run', 'on_demand']).optional(),
  })
  .strict();

export const ContextSchema = z.array(z.union([z.string().trim().min(1), ContextReferenceSchema]));
