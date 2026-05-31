import { z } from 'zod';
import { CapabilityRequestSchema, ExecutorRequirementSchema } from './workflow-executor-schema.js';
import {
  ArtifactDefinitionSchema,
  ContextSchema,
  EnvValueSchema,
  identifierSchema,
  InputDefinitionSchema,
  InputValueSchema,
  NodeContextEnvelopeSchema,
  NodePolicySchema,
  OutputDefinitionSchema,
  RequiresSchema,
  RetryPolicySchema,
  WorkflowContextDefinitionSchema,
} from './workflow-schema-common.js';
import {
  WorkflowDataCaptureDefinitionSchema,
  WorkflowNotificationDefinitionSchema,
  WorkflowPolicyDefinitionSchema,
  WorkflowRunnerRequirementSchema,
  WorkflowTriggerDefinitionSchema,
} from './workflow-production-schema.js';

export const WORKFLOW_SCHEMA_VERSION = 'viewport.workflow/v1' as const;

const HookRecordSchema = z
  .object({
    record: z.boolean().optional(),
  })
  .strict();

const PermissionHookDecisionSchema = z
  .object({
    behavior: z.enum(['allow', 'deny']),
    message: z.string().trim().min(1).optional(),
  })
  .strict();

const PermissionHookRuleSchema = z.union([
  PermissionHookDecisionSchema,
  z
    .object({
      default: PermissionHookDecisionSchema.optional(),
      tools: z.record(z.string().trim().min(1), PermissionHookDecisionSchema).optional(),
    })
    .strict()
    .refine((rule) => Boolean(rule.default) || Boolean(rule.tools), {
      message: 'Set default or tools for PermissionRequest hook rules.',
    }),
]);

const HookRulesSchema = z
  .object({
    PreToolUse: HookRecordSchema.optional(),
    PostToolUse: HookRecordSchema.optional(),
    PostToolUseFailure: HookRecordSchema.optional(),
    PermissionRequest: PermissionHookRuleSchema.optional(),
  })
  .strict();

const InlineAgentDefinitionSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    prompt: z.string().trim().min(1),
    agent: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    executionMode: z.enum(['plan', 'read_only', 'implement', 'review']).optional(),
    allowedTools: z.array(z.string().trim().min(1)).optional(),
    timeoutSeconds: z.number().int().positive().max(86_400).optional(),
  })
  .strict();

const GateDefinitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('check'),
      expression: z.string().trim().min(1),
      description: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('policy'),
      expression: z.string().trim().min(1),
      description: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('human_review'),
      prompt: z.string().trim().min(1),
      description: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('schedule'),
      waitUntil: z.string().trim().min(1),
      description: z.string().optional(),
    })
    .strict(),
]);

const TriggerRuleSchema = z.enum(['all_success', 'all_done', 'one_success']);

const ApprovalRecipientSchema = z
  .object({
    role: z.string().trim().min(1).optional(),
    tag: z.string().trim().min(1).optional(),
    user: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((recipient) => Boolean(recipient.role || recipient.tag || recipient.user), {
    message: 'Approval recipient must specify role, tag, or user.',
  });

const PlanRevisionSchema = z
  .object({
    onRequestChanges: z.enum(['revise_with_agent', 'wait_for_new_plan']).optional(),
    prompt: z.string().trim().min(1).optional(),
    agent: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    timeoutSeconds: z.number().int().positive().max(86_400).optional(),
  })
  .strict();

const NodeBaseSchema = z.object({
  title: z.string().trim().min(1).optional(),
  needs: z.array(z.string().trim().min(1)).optional(),
  when: z.string().trim().min(1).optional(),
  triggerRule: TriggerRuleSchema.optional(),
  timeoutSeconds: z.number().int().positive().max(86_400).optional(),
  retry: RetryPolicySchema.optional(),
  policy: NodePolicySchema.optional(),
  outputs: z.record(identifierSchema, OutputDefinitionSchema).optional(),
  outputSchema: z.record(identifierSchema, OutputDefinitionSchema).optional(),
  artifacts: z.record(identifierSchema, ArtifactDefinitionSchema).optional(),
  env: z.record(identifierSchema, EnvValueSchema).optional(),
  context: NodeContextEnvelopeSchema.optional(),
});

const PromptNodeSchema = NodeBaseSchema.extend({
  type: z.literal('prompt'),
  prompt: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  requiredFiles: z.array(z.string().trim().min(1)).optional(),
  agent: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  executionMode: z.enum(['plan', 'read_only', 'implement', 'review']).optional(),
  allowedTools: z.array(z.string().trim().min(1)).optional(),
  hooks: HookRulesSchema.optional(),
  agents: z.record(identifierSchema, InlineAgentDefinitionSchema).optional(),
  inlineAgentFailurePolicy: z.enum(['fail', 'continue']).optional(),
}).strict();

const AgentNodeSchema = NodeBaseSchema.extend({
  type: z.literal('agent'),
  prompt: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  agent: z.string().trim().min(1),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  executionMode: z.enum(['plan', 'read_only', 'implement', 'review']).optional(),
  allowedTools: z.array(z.string().trim().min(1)).optional(),
  session: z
    .object({
      resume: z.boolean().optional(),
      title: z.string().trim().min(1).optional(),
    })
    .strict()
    .optional(),
  handoff: z
    .object({
      artifact: identifierSchema.optional(),
      summary: z.string().trim().min(1).optional(),
    })
    .strict()
    .optional(),
  hooks: HookRulesSchema.optional(),
}).strict();

const ShellNodeSchema = NodeBaseSchema.extend({
  type: z.literal('shell'),
  command: z.string().trim().min(1).optional(),
  argv: z.array(z.string().trim().min(1)).min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
}).strict();

const CheckoutNodeSchema = NodeBaseSchema.extend({
  type: z.literal('checkout'),
  repository: z.string().trim().min(1),
  remote: z.string().trim().min(1).optional(),
  ref: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  credentialMode: z.enum(['runner_local', 'run_scoped_grant']).optional(),
  credentialRef: z.string().trim().min(1).optional(),
}).strict();

const GitPublishNodeSchema = NodeBaseSchema.extend({
  type: z.literal('git_publish'),
  repository: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  message: z.string().trim().min(1),
  paths: z.array(z.string().trim().min(1)).optional(),
  allowEmpty: z.boolean().optional(),
  push: z.boolean().optional(),
  credentialMode: z.enum(['runner_local', 'run_scoped_grant']).optional(),
  credentialRef: z.string().trim().min(1).optional(),
  restrictedBranches: z.array(z.string().trim().min(1)).optional(),
  restrictedPaths: z.array(z.string().trim().min(1)).optional(),
  prePublishReview: z
    .object({
      rules: z
        .array(
          z
            .object({
              name: z.string().trim().min(1),
              when: z
                .object({
                  changed_paths_any: z.array(z.string().trim().min(1)).optional(),
                  diff_lines_gt: z.number().int().nonnegative().optional(),
                })
                .strict(),
              require: z.string().trim().min(1).optional(),
              reviewers: z
                .object({ tags: z.array(z.string().trim().min(1)).optional() })
                .strict()
                .optional(),
              timeout: z.string().trim().min(1).optional(),
              on_timeout: z.enum(['escalate', 'auto-approve', 'cancel']).optional(),
            })
            .strict()
            .refine(
              (rule) =>
                (rule.when.changed_paths_any?.length ?? 0) > 0 ||
                rule.when.diff_lines_gt !== undefined,
              { message: 'prePublishReview rule must set at least one observable condition' },
            ),
        )
        .min(1),
    })
    .strict()
    .optional(),
}).strict();

const ApprovalOnRejectSchema = z.union([
  z
    .object({
      command: z.string().trim().min(1),
      cwd: z.string().trim().min(1).optional(),
      timeoutSeconds: z.number().int().positive().max(86_400).optional(),
    })
    .strict(),
  z
    .object({
      prompt: z.string().trim().min(1),
      agent: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    })
    .strict(),
]);

const ApprovalNodeSchema = NodeBaseSchema.extend({
  type: z.literal('approval'),
  prompt: z.string().trim().min(1),
  recipients: z.array(ApprovalRecipientSchema).optional(),
  gate_intent: z.enum(['plan', 'approval']).optional(),
  reviewer_tags: z.array(z.string().trim().min(1)).optional(),
  timeout: z.string().trim().min(1).optional(),
  on_timeout: z.enum(['escalate', 'auto-approve', 'cancel']).optional(),
  captureResponse: z.boolean().optional(),
  onReject: ApprovalOnRejectSchema.optional(),
}).strict();

const PlanNodeSchema = NodeBaseSchema.extend({
  type: z.literal('plan'),
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1),
  summary: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
  sourceRef: z.string().trim().min(1).optional(),
  waitForApproval: z.boolean().optional(),
  recipients: z.array(ApprovalRecipientSchema).optional(),
  revision: PlanRevisionSchema.optional(),
}).strict();

const ContextUpdateNodeSchema = NodeBaseSchema.extend({
  type: z.literal('context_update'),
  targetRef: z.string().trim().min(1),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1).optional(),
  patch: z
    .object({
      mode: z.enum(['append', 'replace', 'patch']).optional(),
      text: z.string().trim().min(1).optional(),
      digest: z.string().trim().min(1).optional(),
      operation: z.string().trim().min(1).optional(),
      files: z
        .array(
          z
            .object({
              path: z.string().trim().min(1),
              operation: z.string().trim().min(1).optional(),
              patch_digest: z.string().trim().min(1).optional(),
              artifact_ref: z.string().trim().min(1).optional(),
              before_digest: z.string().trim().min(1).optional(),
              after_digest: z.string().trim().min(1).optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
}).strict();

const GateNodeSchema = NodeBaseSchema.extend({
  type: z.literal('gate'),
  gate: GateDefinitionSchema,
}).strict();

const ContextNodeSchema = NodeBaseSchema.extend({
  type: z.literal('context'),
  refs: ContextSchema.optional(),
  query: z.string().trim().min(1).optional(),
  refresh: z.enum(['manual', 'before_run', 'on_demand']).optional(),
}).strict();

const ConditionNodeSchema = NodeBaseSchema.extend({
  type: z.literal('condition'),
  expression: z.string().trim().min(1),
  then: z.array(identifierSchema).optional(),
  else: z.array(identifierSchema).optional(),
}).strict();

const ArtifactNodeSchema = NodeBaseSchema.extend({
  type: z.literal('artifact'),
  name: identifierSchema,
  from: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  kind: z.enum(['file', 'directory', 'patch', 'report', 'log', 'url']).optional(),
  description: z.string().optional(),
}).strict();

const ActionNodeSchema = NodeBaseSchema.extend({
  type: z.literal('action'),
  adapter: identifierSchema,
  action: identifierSchema,
  with: z.record(identifierSchema, InputValueSchema).optional(),
  proposalKey: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  requiresApproval: z.boolean().optional(),
}).strict();

const LoopBodySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('shell'),
      command: z.string().trim().min(1),
      cwd: z.string().trim().min(1).optional(),
      timeoutSeconds: z.number().int().positive().max(86_400).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prompt'),
      prompt: z.string().trim().min(1),
      agent: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    })
    .strict(),
]);

const LoopNodeSchema = NodeBaseSchema.extend({
  type: z.literal('loop'),
  foreach: z.string().trim().min(1).optional(),
  while: z.string().trim().min(1).optional(),
  until: z.string().trim().min(1).optional(),
  maxIterations: z.number().int().min(1).max(1000),
  body: LoopBodySchema,
})
  .strict()
  .superRefine((node, ctx) => {
    const modes = [node.foreach, node.while, node.until].filter(Boolean).length;
    if (modes !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Loop node must specify exactly one of foreach, while, or until.',
        path: [],
      });
    }
  });

const SubflowChildShellSchema = z
  .object({
    type: z.literal('shell'),
    title: z.string().trim().min(1).optional(),
    needs: z.array(z.string().trim().min(1)).optional(),
    when: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1).optional(),
    timeoutSeconds: z.number().int().positive().max(86_400).optional(),
    outputs: z.record(identifierSchema, OutputDefinitionSchema).optional(),
  })
  .strict();

const SubflowChildSchema = z.discriminatedUnion('type', [SubflowChildShellSchema]);

const SubflowNodeSchema = NodeBaseSchema.extend({
  type: z.literal('subflow'),
  inline: z
    .object({
      nodes: z.record(z.string().trim().min(1), SubflowChildSchema),
    })
    .strict(),
  inputs: z.record(identifierSchema, z.string().trim().min(1)).optional(),
}).strict();

const WorkflowNodeSchema = z.discriminatedUnion('type', [
  AgentNodeSchema,
  PromptNodeSchema,
  ShellNodeSchema,
  CheckoutNodeSchema,
  GitPublishNodeSchema,
  ApprovalNodeSchema,
  PlanNodeSchema,
  ContextUpdateNodeSchema,
  GateNodeSchema,
  ContextNodeSchema,
  ConditionNodeSchema,
  ArtifactNodeSchema,
  ActionNodeSchema,
  LoopNodeSchema,
  SubflowNodeSchema,
]);

export const WorkflowDefinitionSchema = z
  .object({
    schema: z.literal(WORKFLOW_SCHEMA_VERSION),
    name: identifierSchema,
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    scope: z
      .object({
        repos: z.array(z.string().trim().min(1)).optional(),
      })
      .strict()
      .optional(),
    inputs: z.record(z.string(), InputDefinitionSchema).optional(),
    triggers: z.array(WorkflowTriggerDefinitionSchema).optional(),
    context: WorkflowContextDefinitionSchema.optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
    requires: RequiresSchema.optional(),
    executor: ExecutorRequirementSchema.optional(),
    runner: WorkflowRunnerRequirementSchema.optional(),
    policies: WorkflowPolicyDefinitionSchema.optional(),
    notifications: WorkflowNotificationDefinitionSchema.optional(),
    dataCapture: WorkflowDataCaptureDefinitionSchema.optional(),
    capabilityRequests: z.array(CapabilityRequestSchema).optional(),
    nodes: z.record(z.string().trim().min(1), WorkflowNodeSchema),
  })
  .strict();
