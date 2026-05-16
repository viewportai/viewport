import { z } from 'zod';
import { SchemaIds } from './schema-ids.js';
import { ProtocolDocumentSchemas } from './schemas.js';
import type { ProtocolSample } from './samples.js';

export interface ProtocolValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ProtocolValidationResult {
  readonly ok: boolean;
  readonly issues: ProtocolValidationIssue[];
}

const SchemaEnvelope = z.object({ schema: z.string().trim().min(1) }).passthrough();
const RepoConfigEnvelope = z
  .object({
    schema: z.literal(SchemaIds.repoConfig),
    version: z.literal(1).optional(),
  })
  .passthrough();

export function validateSampleEnvelope(sample: ProtocolSample): ProtocolValidationResult {
  if (sample.contract.schemaId === SchemaIds.repoConfig) {
    const parsed = RepoConfigEnvelope.safeParse(sample.document);
    return parsed.success
      ? { ok: true, issues: [] }
      : {
          ok: false,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || '<root>',
            message: issue.message,
          })),
        };
  }

  const parsed = SchemaEnvelope.safeParse(sample.document);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '<root>',
        message: issue.message,
      })),
    };
  }

  if (parsed.data.schema !== sample.contract.schemaId) {
    return {
      ok: false,
      issues: [
        {
          path: 'schema',
          message: `Expected ${sample.contract.schemaId}, got ${parsed.data.schema}.`,
        },
      ],
    };
  }

  const contractSchema = ProtocolDocumentSchemas[parsed.data.schema as keyof typeof ProtocolDocumentSchemas];
  if (contractSchema) {
    const contractParsed = contractSchema.safeParse(sample.document);
    return contractParsed.success
      ? { ok: true, issues: [] }
      : {
          ok: false,
          issues: contractParsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || '<root>',
            message: issue.message,
          })),
        };
  }

  return { ok: true, issues: [] };
}
