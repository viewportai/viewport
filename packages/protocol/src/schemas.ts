import { z } from 'zod';
import { SchemaIds } from './schema-ids.js';

const NonEmptyString = z.string().trim().min(1);
const OptionalStringList = z.array(NonEmptyString).min(1).optional();

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

export const ProtocolDocumentSchemas = {
  [SchemaIds.route]: RouteContractSchema,
  [SchemaIds.executionProfile]: ExecutionProfileContractSchema,
} as const;

