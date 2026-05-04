import { z } from 'zod';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-zA-Z0-9._/-]+$/);

const ExecutorTargetKindSchema = z.enum([
  'local_private',
  'local_sandbox',
  'managed',
  'self_hosted',
  'ci',
]);

const ExecutorCapabilitySchema = z.enum([
  'agent.prompt',
  'artifacts',
  'cancel',
  'files.read',
  'files.write',
  'network.egress',
  'resume',
  'secrets',
  'shell',
  'worktree',
]);

export const ExecutorRequirementSchema = z
  .object({
    targets: z.array(ExecutorTargetKindSchema).min(1).optional(),
    defaultTarget: ExecutorTargetKindSchema.optional(),
    capabilities: z.array(ExecutorCapabilitySchema).min(1).optional(),
  })
  .strict()
  .superRefine((executor, ctx) => {
    if (
      executor.defaultTarget &&
      executor.targets &&
      !executor.targets.includes(executor.defaultTarget)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'defaultTarget must be included in targets.',
        path: ['defaultTarget'],
      });
    }
  });

export const CapabilityRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('secret'),
      ref: identifierSchema,
      reason: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('network_egress'),
      host: z.string().trim().min(1),
      reason: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('write_scope'),
      path: z.string().trim().min(1),
      reason: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('repo_access'),
      ref: z.string().trim().min(1),
      reason: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('context'),
      ref: z.string().trim().min(1),
      reason: z.string().trim().min(1),
    })
    .strict(),
]);
