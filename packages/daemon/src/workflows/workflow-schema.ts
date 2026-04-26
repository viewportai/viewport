import { z } from 'zod';

const InputDefinitionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })
  .strict();

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-zA-Z0-9._/-]+$/);

const OutputDefinitionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'json', 'file', 'artifact']),
    description: z.string().optional(),
  })
  .strict();

const ArtifactDefinitionSchema = z
  .object({
    path: z.string().trim().min(1),
    type: z.enum(['file', 'directory', 'patch', 'report', 'log']).optional(),
    description: z.string().optional(),
  })
  .strict();

const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    backoffSeconds: z.number().int().min(0).max(86_400).optional(),
    transient: z.array(z.string().min(1)).optional(),
    fatal: z.array(z.string().min(1)).optional(),
  })
  .strict();

const NodePolicySchema = z
  .object({
    onFailure: z.enum(['halt', 'continue', 'skip_dependents']).optional(),
    approvalRequired: z.boolean().optional(),
  })
  .strict();

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

const EnvValueSchema = z
  .object({
    value: z.string().optional(),
    secret: identifierSchema.optional(),
  })
  .strict()
  .refine((entry) => Boolean(entry.value) !== Boolean(entry.secret), {
    message: 'Set exactly one of value or secret.',
  });

const RequiresSchema = z
  .object({
    agents: z.array(z.string().trim().min(1)).optional(),
    tools: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const TriggerRuleSchema = z.enum(['all_success', 'all_done', 'one_success']);

const NodeBaseSchema = z.object({
  title: z.string().trim().min(1).optional(),
  needs: z.array(z.string().trim().min(1)).optional(),
  when: z.string().trim().min(1).optional(),
  triggerRule: TriggerRuleSchema.optional(),
  timeoutSeconds: z.number().int().positive().max(86_400).optional(),
  retry: RetryPolicySchema.optional(),
  policy: NodePolicySchema.optional(),
  outputs: z.record(identifierSchema, OutputDefinitionSchema).optional(),
  artifacts: z.record(identifierSchema, ArtifactDefinitionSchema).optional(),
  env: z.record(identifierSchema, EnvValueSchema).optional(),
});

const PromptNodeSchema = NodeBaseSchema.extend({
  type: z.literal('prompt'),
  prompt: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  hooks: HookRulesSchema.optional(),
  agents: z.record(identifierSchema, InlineAgentDefinitionSchema).optional(),
  inlineAgentFailurePolicy: z.enum(['fail', 'continue']).optional(),
}).strict();

const ShellNodeSchema = NodeBaseSchema.extend({
  type: z.literal('shell'),
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
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
    })
    .strict(),
]);

const ApprovalNodeSchema = NodeBaseSchema.extend({
  type: z.literal('approval'),
  prompt: z.string().trim().min(1),
  captureResponse: z.boolean().optional(),
  onReject: ApprovalOnRejectSchema.optional(),
}).strict();

const GateNodeSchema = NodeBaseSchema.extend({
  type: z.literal('gate'),
  gate: GateDefinitionSchema,
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
  PromptNodeSchema,
  ShellNodeSchema,
  ApprovalNodeSchema,
  GateNodeSchema,
  LoopNodeSchema,
  SubflowNodeSchema,
]);

export const WorkflowDefinitionSchema = z
  .object({
    schema: z.literal('viewport.workflow/v1'),
    name: identifierSchema,
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    inputs: z.record(z.string(), InputDefinitionSchema).optional(),
    requires: RequiresSchema.optional(),
    nodes: z.record(z.string().trim().min(1), WorkflowNodeSchema),
  })
  .strict();
