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
    target: identifierSchema.optional(),
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
        allowed: z
          .array(
            z.union([
              z.string().trim().min(1),
              z
                .object({
                  provider: z.string().trim().min(1).optional(),
                  adapter: z.string().trim().min(1).optional(),
                  action: z.string().trim().min(1).optional(),
                  actions: z.array(z.string().trim().min(1)).optional(),
                })
                .strict(),
            ]),
          )
          .optional(),
      })
      .strict()
      .optional(),
    shell: z
      .object({
        policy: z.enum(['constrained', 'disabled']).optional(),
        mode: z.enum(['constrained', 'disabled']).optional(),
        allowLegacyCommand: z.boolean().optional(),
        allow_legacy_command: z.boolean().optional(),
        allowed: z.array(z.string().trim().min(1)).optional(),
        denied: z.array(z.string().trim().min(1)).optional(),
      })
      .strict()
      .optional(),
    escalation: z
      .object({
        whenStuck: z
          .string()
          .regex(/^human\([a-zA-Z0-9_, -]+\)$/)
          .optional(),
        reviewerTags: z.array(z.string().trim().min(1)).optional(),
        channel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    budget: z
      .object({
        maxTokens: z.number().int().positive().optional(),
        tokens: z.number().int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
        usd: z.number().positive().optional(),
        approvalThresholds: z
          .object({
            tokens: z.number().int().positive().optional(),
            costUsd: z.number().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    maxDurationSeconds: z.number().int().positive().max(604_800).optional(),
  })
  .strict();

const LegacyInboxNotificationSchema = z.array(
  z.enum(['approval_requested', 'run_failed', 'runner_offline', 'action_failed']),
);

const SlackInboxNotificationSchema = z
  .object({
    enabled: z.boolean().optional(),
    credential_ref: z.string().trim().min(1).optional(),
    credential: z.string().trim().min(1).optional(),
    delivery: z
      .union([
        z.enum(['source_thread', 'dm_assignee', 'dm_requester', 'channel']),
        z.array(z.enum(['source_thread', 'dm_assignee', 'dm_requester', 'channel'])),
      ])
      .optional(),
    events: z.array(z.string().trim().min(1)).optional(),
    channel: z.string().trim().min(1).optional(),
    template: z.string().trim().min(1).optional(),
  })
  .strict();

const InboxNotificationSchema = z.union([
  LegacyInboxNotificationSchema,
  z
    .object({
      slack: SlackInboxNotificationSchema.optional(),
    })
    .strict(),
]);

const SourceAcceptedNotificationSchema = z.union([
  z.boolean(),
  z
    .object({
      enabled: z.boolean().optional(),
      provider: z.string().trim().min(1).optional(),
      credential_ref: z.string().trim().min(1).optional(),
      credential: z.string().trim().min(1).optional(),
      delivery: z.enum(['source_thread', 'channel', 'dm_requester']).optional(),
      mode: z.enum(['source_thread', 'channel', 'dm_requester']).optional(),
      channel: z.string().trim().min(1).optional(),
      thread_ts: z.string().trim().min(1).optional(),
      user_id: z.string().trim().min(1).optional(),
      template: z.string().trim().min(1).optional(),
      onFailure: z.enum(['continue', 'fail_run']).optional(),
      failurePolicy: z.enum(['continue', 'fail_run']).optional(),
    })
    .strict(),
]);

export const WorkflowNotificationDefinitionSchema = z
  .object({
    inbox: InboxNotificationSchema.optional(),
    email: z.array(z.enum(['approval_requested', 'run_failed', 'run_completed'])).optional(),
    webhook: z.array(z.string().trim().min(1)).optional(),
    sourceAccepted: SourceAcceptedNotificationSchema.optional(),
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
