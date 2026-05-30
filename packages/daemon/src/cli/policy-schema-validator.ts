/**
 * Policy and route-config schema validators for `vpd check`.
 *
 * Canonical source: viewportai/protocol/src/policy-schema.ts
 *                   viewportai/protocol/src/route-config-schema.ts
 *
 * This file is a copy because the protocol package is a separate repo not yet
 * published to npm. When @viewportai/protocol is available as an npm dependency,
 * replace these schemas with imports from the published package.
 *
 * Drift is caught by the shared conformance fixture corpus:
 *   viewportai/protocol/tests/policy-schema-conformance.test.ts
 */
import { z } from 'zod';

// ── Policy schema ────────────────────────────────────────────────────────────

const PolicyRepoSchema = z
  .object({
    repo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    access: z.enum(['read-write', 'read-only']),
    branches: z
      .object({
        push_allowed: z.array(z.string()).optional(),
        restricted: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    paths: z
      .object({
        write_allowed: z.array(z.string()).optional(),
        restricted: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    credential: z.enum(['runner-local', 'brokered']).default('runner-local'),
  })
  .strict();

const PolicyGateSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['plan', 'approval', 'auto', 'budget']),
    reviewers: z.object({ tags: z.array(z.string()).min(1) }).strict().optional(),
    timeout: z.string().optional(),
    on_timeout: z.enum(['escalate', 'auto-approve', 'cancel']).optional(),
    auto_approve_if: z
      .object({
        tests_pass: z.boolean().optional(),
        files_changed_outside: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    max_cost_usd: z.number().optional(),
    max_tokens: z.number().optional(),
    on_exceed: z.enum(['cancel', 'escalate']).optional(),
  })
  .strict();

const PolicyInvokeStepSchema = z
  .object({
    name: z.string().min(1),
    gate: z.string().optional(),
    action: z.string().optional(),
    prompt: z.string().optional(),
    target: z.enum(['primary']).optional(),
    template: z.string().optional(),
  })
  .strict();

const PolicyContextSourceSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['file', 'vault', 'trigger', 'git-repo']),
    path: z.string().optional(),
    vault: z.string().optional(),
    repo: z.string().optional(),
    ref: z.string().optional(),
  })
  .strict();

export const PolicyDocumentSchema = z
  .object({
    version: z.literal(1),
    repos: z.array(PolicyRepoSchema).min(1),
    context: z
      .object({
        sources: z.array(PolicyContextSourceSchema).optional(),
        capture_policy: z
          .object({
            store_transcripts: z.boolean().default(false),
            store_diffs: z.boolean().default(true),
            redact_patterns: z.array(z.string()).default([]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    gates: z.array(PolicyGateSchema).optional(),
    invoke: z
      .object({
        agent: z.enum(['claude-code', 'codex']).default('claude-code'),
        role: z.string().optional(),
        steps: z.array(PolicyInvokeStepSchema).optional(),
        workflow: z.string().optional(),
      })
      .strict(),
    execution: z
      .object({
        shell_policy: z
          .object({
            allowed: z.array(z.string()).default([]),
            denied: z.array(z.string()).default([]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.invoke.steps && data.gates) {
      const gateNames = new Set(data.gates.map((g) => g.name));
      for (const step of data.invoke.steps) {
        if (step.gate && !gateNames.has(step.gate)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['invoke', 'steps'],
            message: `Gate '${step.gate}' referenced in steps but not defined in gates[]`,
          });
        }
      }
    }
    if (data.invoke.workflow && data.invoke.steps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invoke'],
        message: 'Cannot specify both invoke.workflow and invoke.steps',
      });
    }
  });

// ── Route config schema ──────────────────────────────────────────────────────

const JiraConditionsSchema = z
  .object({
    project: z.string().optional(),
    status_transition: z.string().optional(),
    issue_type: z.string().optional(),
    label: z.string().optional(),
    assignee: z.enum(['present', 'absent']).optional(),
  })
  .strict();

const GithubConditionsSchema = z
  .object({
    repo: z.string().optional(),
    files_match: z.string().optional(),
    branch: z.string().optional(),
    pr_label: z.string().optional(),
  })
  .strict();

const SlackConditionsSchema = z.object({ channel: z.string().optional() }).strict();

const LinearConditionsSchema = z
  .object({
    team_id: z.string().optional(),
    project: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();

export const RouteConfigDocumentSchema = z
  .object({
    route: z
      .object({
        name: z.string().min(1).regex(/^[a-z0-9-]+$/),
        team: z.string().min(1),
        trigger: z
          .object({
            integration: z.enum(['jira', 'github', 'slack', 'linear']),
            events: z.array(z.string()).min(1),
            conditions: z
              .union([
                JiraConditionsSchema,
                GithubConditionsSchema,
                SlackConditionsSchema,
                LinearConditionsSchema,
                z.object({}).strict(),
              ])
              .optional(),
          })
          .strict(),
        policy: z
          .object({
            source: z.literal('git'),
            repo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
            ref: z.string().default('main'),
            path: z.string().default('.viewport/policy.yaml'),
          })
          .strict(),
        fan_out: z.boolean().default(false),
        priority: z.number().int().min(0).default(10),
      })
      .strict(),
  })
  .strict();
