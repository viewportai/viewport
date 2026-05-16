import { z } from 'zod';
import { SchemaIds } from './schema-ids.js';

const NonEmptyString = z.string().trim().min(1);
const OptionalStringList = z.array(NonEmptyString).min(1).optional();
const IsoDateTime = z.string().datetime({ offset: true });
const Digest = z.string().regex(/^sha256:[A-Za-z0-9._-]+$/);

const RouteMatchClauseSchema = z
  .object({
    source: NonEmptyString,
    eventTypes: OptionalStringList,
    event_types: OptionalStringList,
    project: NonEmptyString.optional(),
    issueTypes: OptionalStringList,
    labelsAny: OptionalStringList,
    channels: OptionalStringList,
    mentionsAny: OptionalStringList,
    repositories: OptionalStringList,
  })
  .passthrough();

export const RouteContractSchema = z
  .object({
    schema: z.literal(SchemaIds.route),
    id: NonEmptyString,
    title: NonEmptyString.optional(),
    enabled: z.boolean().optional(),
    matches: z.object({
      any: z.array(RouteMatchClauseSchema).min(1),
    }),
    resolve: z.object({
      executionProfile: NonEmptyString,
      workflow: NonEmptyString,
    }),
    ambiguity: z
      .object({
        behavior: z.literal('fail_closed'),
        message: NonEmptyString.optional(),
      })
      .passthrough()
      .optional(),
    audit: z
      .object({
        recordPayloadSummary: z.boolean().optional(),
        retainRawPayload: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const ExecutionProfileContractSchema = z
  .object({
    schema: z.literal(SchemaIds.executionProfile),
    id: NonEmptyString,
    title: NonEmptyString.optional(),
    ownedBy: z
      .object({
        team: NonEmptyString,
      })
      .passthrough()
      .optional(),
    repos: z
      .object({
        primary: z.array(NonEmptyString).min(1).optional(),
        related: z.array(NonEmptyString).optional(),
      })
      .passthrough()
      .optional(),
    runner: z
      .object({
        pool: NonEmptyString,
        workspaceTemplate: NonEmptyString.optional(),
        isolation: NonEmptyString.optional(),
      })
      .passthrough(),
    agent: z
      .object({
        default: NonEmptyString,
        allowed: z.array(NonEmptyString).min(1).optional(),
      })
      .passthrough()
      .optional(),
    context: z
      .object({
        packages: z.array(NonEmptyString).optional(),
        refresh: NonEmptyString.optional(),
        cacheTtlSeconds: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    approvals: z.record(z.unknown()).optional(),
    actions: z
      .object({
        allowed: z.array(NonEmptyString).optional(),
        blocked: z.array(NonEmptyString).optional(),
      })
      .passthrough()
      .optional(),
    dataCapture: z
      .object({
        transcripts: NonEmptyString.optional(),
        logs: NonEmptyString.optional(),
        artifacts: NonEmptyString.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ActorSchema = z
  .object({
    kind: NonEmptyString,
    id: NonEmptyString,
    source: NonEmptyString.optional(),
    displayName: NonEmptyString.optional(),
  })
  .passthrough();

export const EvidenceContractSchema = z
  .object({
    schema: z.literal(SchemaIds.evidence),
    id: NonEmptyString,
    workflowRunId: NonEmptyString,
    nodeId: NonEmptyString.optional(),
    kind: NonEmptyString,
    title: NonEmptyString,
    summary: NonEmptyString,
    confidence: NonEmptyString.optional(),
    visibility: NonEmptyString.optional(),
    createdAt: IsoDateTime,
    references: z.array(z.record(z.unknown())).optional(),
    findings: z.array(z.record(z.unknown())).optional(),
    tests: z.array(z.record(z.unknown())).optional(),
    risks: z.array(z.record(z.unknown())).optional(),
    proposedActions: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

export const ActionProposalContractSchema = z
  .object({
    schema: z.literal(SchemaIds.actionProposal),
    id: NonEmptyString,
    workflowRunId: NonEmptyString,
    nodeId: NonEmptyString.optional(),
    adapter: NonEmptyString,
    action: NonEmptyString,
    payload: z.record(z.unknown()),
    idempotencyKey: NonEmptyString,
    proposalDigest: Digest,
    evidenceRefs: z.array(NonEmptyString).optional(),
    policyEvaluation: z
      .object({
        decision: NonEmptyString,
        reason: NonEmptyString.optional(),
        matchedRules: z.array(NonEmptyString).optional(),
        evaluatedAt: IsoDateTime.optional(),
      })
      .passthrough()
      .optional(),
    state: NonEmptyString,
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime.optional(),
  })
  .passthrough();

export const AuthorizationDecisionContractSchema = z
  .object({
    schema: z.literal(SchemaIds.authorizationDecision),
    id: NonEmptyString,
    workspaceId: NonEmptyString,
    occurredAt: IsoDateTime,
    subject: ActorSchema,
    action: NonEmptyString,
    resource: z.record(z.unknown()),
    context: z.record(z.unknown()).optional(),
    decision: z.enum(['allow', 'deny', 'require_approval']),
    reason: NonEmptyString,
    matchedRules: z.array(NonEmptyString).optional(),
    policy: z
      .object({
        id: NonEmptyString,
        version: z.number().int().positive(),
      })
      .passthrough()
      .optional(),
    expiresAt: IsoDateTime.optional(),
  })
  .passthrough();

export const ApprovalDecisionContractSchema = z
  .object({
    schema: z.literal(SchemaIds.approvalDecision),
    id: NonEmptyString,
    subjectType: NonEmptyString,
    subjectId: NonEmptyString,
    subjectDigest: Digest,
    decision: z.enum(['approve', 'deny', 'request_changes']),
    actor: ActorSchema,
    reason: NonEmptyString.optional(),
    createdAt: IsoDateTime,
  })
  .passthrough();

export const ContextReceiptContractSchema = z
  .object({
    schema: z.literal(SchemaIds.contextReceipt),
    package: NonEmptyString,
    requested: NonEmptyString,
    resolvedVersion: NonEmptyString,
    provider: NonEmptyString,
    digest: Digest,
    freshness: NonEmptyString,
    usedBy: z
      .object({
        runId: NonEmptyString,
        nodeId: NonEmptyString.optional(),
      })
      .passthrough(),
    resolvedAt: IsoDateTime,
  })
  .passthrough();

export const AuditReceiptContractSchema = z
  .object({
    schema: z.literal(SchemaIds.auditReceipt),
    id: NonEmptyString,
    workspaceId: NonEmptyString,
    workflowRunId: NonEmptyString,
    eventType: NonEmptyString,
    occurredAt: IsoDateTime,
    actor: ActorSchema,
    route: z
      .object({
        id: NonEmptyString,
        version: z.number().int().positive(),
      })
      .passthrough()
      .optional(),
    executionProfile: z
      .object({
        id: NonEmptyString,
        version: z.number().int().positive(),
      })
      .passthrough()
      .optional(),
    workflow: z
      .object({
        id: NonEmptyString,
        schema: z.literal(SchemaIds.workflow),
        digest: Digest,
      })
      .passthrough(),
    contextReceipts: z.array(z.record(z.unknown())).optional(),
    evidenceRefs: z.array(NonEmptyString).optional(),
    actionProposal: z
      .object({
        id: NonEmptyString,
        digest: Digest,
      })
      .passthrough()
      .optional(),
    approvalDecision: z.record(z.unknown()).optional(),
    sideEffectReceipt: z
      .object({
        adapter: NonEmptyString,
        action: NonEmptyString,
        status: NonEmptyString,
      })
      .passthrough()
      .optional(),
    payloadDigest: Digest,
  })
  .passthrough();

export const ProtocolDocumentSchemas = {
  [SchemaIds.route]: RouteContractSchema,
  [SchemaIds.executionProfile]: ExecutionProfileContractSchema,
  [SchemaIds.evidence]: EvidenceContractSchema,
  [SchemaIds.actionProposal]: ActionProposalContractSchema,
  [SchemaIds.authorizationDecision]: AuthorizationDecisionContractSchema,
  [SchemaIds.approvalDecision]: ApprovalDecisionContractSchema,
  [SchemaIds.contextReceipt]: ContextReceiptContractSchema,
  [SchemaIds.auditReceipt]: AuditReceiptContractSchema,
} as const;
