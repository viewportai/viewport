/**
 * Run-receipt validation against the canonical `@viewportai/protocol`
 * contract (HARD-02 thin slice).
 *
 * The protocol package is the single source of truth for
 * `viewport.run_receipt/v1`: this module reuses its Zod schema and canonical
 * JSON v1 digest implementation instead of hand-copying either. Receipt
 * documents flowing through the daemon's receipt-sync path (platform exports,
 * local verification) should be validated here so daemon, API, and web can
 * never drift on the receipt spine independently.
 */
import {
  RUN_RECEIPT_ENTRY_SCHEMA_ID,
  RunReceiptDocumentSchema,
  canonicalDigest,
  type RunReceiptDocument,
} from '@viewportai/protocol';

export interface RunReceiptValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface RunReceiptValidationResult {
  readonly ok: boolean;
  readonly issues: RunReceiptValidationIssue[];
  /** Present when schema validation passed (even if chain checks failed). */
  readonly document?: RunReceiptDocument;
}

/**
 * Validates a `viewport.run_receipt/v1` document against the protocol schema
 * and re-verifies its digest chain (entry digests, prev links, chain head,
 * document digest) using the protocol's canonical JSON v1 implementation.
 */
export function validateRunReceiptDocument(input: unknown): RunReceiptValidationResult {
  const parsed = RunReceiptDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '<root>',
        message: issue.message,
      })),
    };
  }

  const document = parsed.data;
  const issues: RunReceiptValidationIssue[] = [];

  let expectedDocumentDigest: string | null = null;
  try {
    expectedDocumentDigest = canonicalDigest({
      run: document.run,
      policy_of_record: document.policy_of_record,
    });
  } catch (error) {
    issues.push({
      path: 'document_digest',
      message: `Document is not canonical-JSON encodable: ${(error as Error).message}`,
    });
  }
  if (expectedDocumentDigest !== null && expectedDocumentDigest !== document.document_digest) {
    issues.push({
      path: 'document_digest',
      message: `Document digest mismatch (expected ${expectedDocumentDigest}).`,
    });
  }

  let prevDigest: string | null = null;
  for (const [index, entry] of document.entries.entries()) {
    const entryPath = `entries.${index}`;
    if (entry.seq !== index + 1) {
      issues.push({
        path: `${entryPath}.seq`,
        message: `Expected seq ${index + 1}, got ${entry.seq}.`,
      });
    }
    if (entry.prev_digest !== prevDigest) {
      issues.push({
        path: `${entryPath}.prev_digest`,
        message: `Chain link broken (expected ${prevDigest ?? 'null'}).`,
      });
    }
    try {
      const expectedEntryDigest = canonicalDigest(
        {
          schema: RUN_RECEIPT_ENTRY_SCHEMA_ID,
          workspace_id: document.run.workspace_id,
          workflow_run_id: document.run.id,
          seq: entry.seq,
          leg: entry.leg,
          occurred_at: entry.occurred_at,
          actor: entry.actor,
          summary: entry.summary,
        },
        prevDigest,
      );
      if (expectedEntryDigest !== entry.entry_digest) {
        issues.push({
          path: `${entryPath}.entry_digest`,
          message: `Entry digest mismatch (expected ${expectedEntryDigest}).`,
        });
      }
    } catch (error) {
      issues.push({
        path: `${entryPath}.entry_digest`,
        message: `Entry is not canonical-JSON encodable: ${(error as Error).message}`,
      });
    }
    prevDigest = entry.entry_digest;
  }

  const lastEntry = document.entries[document.entries.length - 1];
  if (lastEntry && document.chain_head.seq !== lastEntry.seq) {
    issues.push({
      path: 'chain_head.seq',
      message: `Chain head seq ${document.chain_head.seq} != last entry seq ${lastEntry.seq}.`,
    });
  }
  if (lastEntry && document.chain_head.digest !== lastEntry.entry_digest) {
    issues.push({
      path: 'chain_head.digest',
      message: 'Chain head digest does not match the last entry digest.',
    });
  }

  return { ok: issues.length === 0, issues, document };
}
