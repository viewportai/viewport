import { z } from 'zod';
import { identifierSchema, InputValueSchema } from './workflow-schema-common.js';

export const WorkflowTriggerDefinitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('manual'),
      title: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      inputs: z.record(z.string(), InputValueSchema).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('webhook'),
      title: z.string().trim().min(1).optional(),
      provider: z.string().trim().min(1).optional(),
      route: identifierSchema.optional(),
      eventTypes: z.array(z.string().trim().min(1)).optional(),
      signature: z
        .object({
          algorithm: z.enum(['hmac-sha256']),
          header: z.string().trim().min(1),
          timestampHeader: z.string().trim().min(1).optional(),
          toleranceSeconds: z.number().int().positive().max(86_400).optional(),
        })
        .strict()
        .optional(),
      map: z.record(identifierSchema, z.string().trim().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('schedule'),
      title: z.string().trim().min(1).optional(),
      cron: z.string().trim().min(1),
      timezone: z.string().trim().min(1).optional(),
      missedRun: z.enum(['skip', 'catch_up_once', 'route_to_inbox']).optional(),
    })
    .strict(),
]);

export const WorkflowRunnerRequirementSchema = z
  .object({
    kind: z.enum(['paired_daemon', 'self_hosted_runner']).optional(),
    target: z.enum(['local_private', 'local_sandbox', 'managed', 'self_hosted', 'ci']).optional(),
    capabilities: z
      .array(
        z.enum([
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
        ]),
      )
      .optional(),
    labels: z.array(identifierSchema).optional(),
    profile: identifierSchema.optional(),
    leaseSeconds: z.number().int().positive().max(86_400).optional(),
  })
  .strict();

export const WorkflowPolicyDefinitionSchema = z
  .object({
    run: z
      .object({
        allowed: z.array(z.string().trim().min(1)).optional(),
        requireOnlineRunner: z.boolean().optional(),
      })
      .strict()
      .optional(),
    approve: z
      .object({
        allowed: z.array(z.string().trim().min(1)).optional(),
        minApprovals: z.number().int().min(1).max(10).optional(),
      })
      .strict()
      .optional(),
    sideEffects: z
      .object({
        requireApproval: z.boolean().optional(),
        allowedAdapters: z.array(identifierSchema).optional(),
      })
      .strict()
      .optional(),
    maxDurationSeconds: z.number().int().positive().max(604_800).optional(),
  })
  .strict();

export const WorkflowNotificationDefinitionSchema = z
  .object({
    inbox: z
      .array(z.enum(['approval_requested', 'run_failed', 'runner_offline', 'action_failed']))
      .optional(),
    email: z.array(z.enum(['approval_requested', 'run_failed', 'run_completed'])).optional(),
    webhook: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export const WorkflowDataCaptureDefinitionSchema = z
  .object({
    logs: z.enum(['compact', 'full', 'off']).optional(),
    artifacts: z.boolean().optional(),
    contextEvidence: z.boolean().optional(),
    approvalPackets: z.boolean().optional(),
  })
  .strict();
