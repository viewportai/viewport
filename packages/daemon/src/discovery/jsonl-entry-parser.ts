export type RichSessionMessage =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; ts: string; uuid: string }
  | {
      kind: 'command';
      command: string;
      cwd?: string;
      status: 'started' | 'completed';
      exitCode?: number | null;
      output?: string;
      durationMs?: number | null;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'file_change';
      path?: string;
      diff?: string;
      operation?: string;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'approval';
      title: string;
      body: string;
      input?: Record<string, unknown>;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'event';
      title: string;
      body: string;
      tone?: 'default' | 'success' | 'warning' | 'danger' | 'muted';
      ts: string;
      uuid: string;
    }
  | {
      kind: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'tool_use';
      toolName: string;
      toolId: string;
      input: Record<string, unknown>;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'tool_result';
      toolId: string;
      output: string;
      isError: boolean;
      ts: string;
      uuid: string;
    }
  | { kind: 'thinking'; text: string; ts: string; uuid: string };

// ---------------------------------------------------------------------------
// Single-entry parser (used by both readSessionMessagesRich and tail events)
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL entry (already JSON.parsed) into RichSessionMessage blocks.
 * A single entry may produce 0, 1, or many blocks (e.g. an assistant message
 * with text + tool_use + thinking blocks).
 *
 * Extracted from readSessionMessagesRich() so both the full-file reader
 * and the incremental tailer can share the same parsing logic.
 */
export function parseJSONLEntry(entry: unknown): RichSessionMessage[] {
  if (typeof entry !== 'object' || entry === null) return [];

  const e = entry as Record<string, unknown>;
  return (
    parseClaudeEntry(e) ??
    parseCodexEventMsgEntry(e) ??
    parseCodexEntry(e) ??
    parseCodexCompactedEntry(e) ??
    []
  );
}

function parseClaudeEntry(e: Record<string, unknown>): RichSessionMessage[] | null {
  const type = e.type as string;
  if (type !== 'user' && type !== 'assistant') return null;

  const ts = (e.timestamp as string) || new Date().toISOString();
  const uuid = (e.uuid as string) || '';
  const message = e.message as Record<string, unknown> | undefined;
  if (!message) return [];

  const content = message.content;
  const blocks: RichSessionMessage[] = [];

  // Simple string content → single text block
  if (typeof content === 'string') {
    if (content) {
      blocks.push({ kind: 'text', role: type, text: content, ts, uuid });
      blocks.push(...viewportPlanEventsFromText(content, ts, `${uuid}-viewport-plan`));
    }
    return blocks;
  }

  if (!Array.isArray(content)) return blocks;

  for (const block of content) {
    if (typeof block === 'string') {
      if (block) {
        blocks.push({ kind: 'text', role: type, text: block, ts, uuid });
      }
      continue;
    }

    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const blockType = b.type as string;

    switch (blockType) {
      case 'text':
        if (typeof b.text === 'string' && b.text) {
          blocks.push({ kind: 'text', role: type, text: b.text, ts, uuid });
          blocks.push(...viewportPlanEventsFromText(b.text, ts, `${uuid}-viewport-plan`));
        }
        break;

      case 'thinking':
        if (typeof b.thinking === 'string' && b.thinking) {
          blocks.push({ kind: 'thinking', text: b.thinking, ts, uuid });
        }
        break;

      case 'tool_use':
        blocks.push(
          ...mapClaudeToolUseToRichBlocks({
            toolName: (b.name as string) || 'unknown',
            toolId: (b.id as string) || '',
            input:
              typeof b.input === 'object' && b.input !== null
                ? (b.input as Record<string, unknown>)
                : {},
            ts,
            uuid,
          }),
        );
        break;

      case 'tool_result': {
        const toolId = (b.tool_use_id as string) || '';
        const isError = b.is_error === true;
        const output = extractToolResultContent(b.content);
        blocks.push({ kind: 'tool_result', toolId, output, isError, ts, uuid });
        blocks.push(...viewportCliEventsFromOutput(output, ts, `${uuid || toolId}-viewport-cli`));
        break;
      }
    }
  }

  return blocks;
}

function mapClaudeToolUseToRichBlocks(input: {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  ts: string;
  uuid: string;
}): RichSessionMessage[] {
  if (input.toolName === 'Bash') {
    const command = typeof input.input.command === 'string' ? input.input.command.trim() : '';
    if (command) {
      return [
        {
          kind: 'command',
          command,
          cwd: typeof input.input.cwd === 'string' ? input.input.cwd : undefined,
          status: 'started',
          ts: input.ts,
          uuid: input.toolId || input.uuid,
        },
      ];
    }
  }

  if (isClaudeFileMutationTool(input.toolName)) {
    const filePath =
      typeof input.input.file_path === 'string'
        ? input.input.file_path
        : typeof input.input.path === 'string'
          ? input.input.path
          : undefined;
    return [
      {
        kind: 'file_change',
        path: filePath,
        operation: input.toolName,
        ts: input.ts,
        uuid: input.toolId || input.uuid,
      },
    ];
  }

  return [
    {
      kind: 'tool_use',
      toolName: input.toolName,
      toolId: input.toolId,
      input: input.input,
      ts: input.ts,
      uuid: input.uuid,
    },
  ];
}

function isClaudeFileMutationTool(toolName: string): boolean {
  return (
    toolName === 'Edit' ||
    toolName === 'Write' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit'
  );
}

function parseCodexEntry(e: Record<string, unknown>): RichSessionMessage[] | null {
  const envelopeType = e.type as string;
  if (envelopeType !== 'response_item') return null;

  const payload =
    typeof e.payload === 'object' && e.payload !== null
      ? (e.payload as Record<string, unknown>)
      : null;
  if (!payload) return [];

  const ts = timestampFromEntry(e, payload);
  const itemType = payload.type as string;

  if (itemType === 'message') {
    const role = normalizeCodexRole(payload.role);
    if (!role) return [];
    const messageBlocks: RichSessionMessage[] = [];
    const content = payload.content;
    const baseUuid = codexUuid(payload, ts, 'message');

    if (typeof content === 'string') {
      const text = content.trim();
      if (text) {
        messageBlocks.push({ kind: 'text', role, text, ts, uuid: baseUuid });
        messageBlocks.push(...viewportPlanEventsFromText(text, ts, `${baseUuid}-viewport-plan`));
      }
      return messageBlocks;
    }

    if (!Array.isArray(content)) return messageBlocks;

    for (let i = 0; i < content.length; i += 1) {
      const item = content[i];
      const itemRec =
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
      const text = extractCodexContentText(itemRec ?? item);
      if (!text) continue;
      messageBlocks.push({
        kind: 'text',
        role,
        text,
        ts,
        uuid: `${baseUuid}-${i}`,
      });
      messageBlocks.push(
        ...viewportPlanEventsFromText(text, ts, `${baseUuid}-${i}-viewport-plan`),
      );
    }
    return messageBlocks;
  }

  if (itemType === 'function_call') {
    const toolId = codexToolId(payload);
    const toolName =
      (typeof payload.name === 'string' && payload.name) ||
      (typeof payload.tool_name === 'string' && payload.tool_name) ||
      'tool';
    return [
      {
        kind: 'tool_use',
        toolName,
        toolId,
        input: parseCodexFunctionCallInput(payload.arguments),
        ts,
        uuid: codexUuid(payload, ts, 'tool-use'),
      },
    ];
  }

  if (itemType === 'function_call_output') {
    const output =
      (typeof payload.output === 'string' && payload.output) ||
      (typeof payload.result === 'string' && payload.result) ||
      '';
    return [
      {
        kind: 'tool_result',
        toolId: codexToolId(payload),
        output,
        isError: payload.is_error === true || payload.isError === true,
        ts,
        uuid: codexUuid(payload, ts, 'tool-result'),
      },
      ...viewportCliEventsFromOutput(
        output,
        ts,
        `${codexUuid(payload, ts, 'tool-result')}-viewport-cli`,
      ),
    ];
  }

  if (itemType === 'reasoning') {
    const thinking = extractCodexReasoning(payload);
    if (!thinking) return [];
    return [
      {
        kind: 'thinking',
        text: thinking,
        ts,
        uuid: codexUuid(payload, ts, 'thinking'),
      },
    ];
  }

  return [
    {
      kind: 'event',
      title: `Provider item: ${itemType || 'unknown'}`,
      body: safeJsonPreview(payload),
      tone: 'muted',
      ts,
      uuid: codexUuid(payload, ts, 'item'),
    },
  ];
}

function parseCodexEventMsgEntry(e: Record<string, unknown>): RichSessionMessage[] | null {
  if (e.type !== 'event_msg') return null;
  const payload =
    typeof e.payload === 'object' && e.payload !== null
      ? (e.payload as Record<string, unknown>)
      : null;
  if (!payload) return [];

  const ts = timestampFromEntry(e, payload);
  const itemType = payload.type as string;
  const uuid = codexUuid(payload, ts, itemType || 'event');

  if (itemType === 'user_message') {
    const text = extractText(payload.message ?? payload.text);
    return text ? [{ kind: 'text', role: 'user', text, ts, uuid }] : [];
  }

  if (itemType === 'agent_message' || itemType === 'assistant_message') {
    const text = extractText(payload.message ?? payload.text);
    return text
      ? [
          { kind: 'text', role: 'assistant', text, ts, uuid },
          ...viewportPlanEventsFromText(text, ts, `${uuid}-viewport-plan`),
        ]
      : [];
  }

  if (itemType === 'agent_message_delta' || itemType === 'agent_message_content_delta') {
    const text = extractText(payload.delta ?? payload.text ?? payload.content);
    return text ? [{ kind: 'text', role: 'assistant', text, ts, uuid }] : [];
  }

  if (itemType === 'exec_command_begin') {
    return [
      {
        kind: 'command',
        command: commandToString(payload.command),
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        status: 'started',
        ts,
        uuid,
      },
    ];
  }

  if (itemType === 'exec_command_end') {
    return [
      {
        kind: 'command',
        command: commandToString(payload.command),
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        status: 'completed',
        exitCode: numberOrNull(payload.exit_code),
        output: extractText(
          payload.aggregated_output ?? payload.formatted_output ?? payload.stdout,
        ),
        durationMs: durationToMs(payload.duration),
        ts,
        uuid,
      },
    ];
  }

  if (itemType === 'exec_approval_request') {
    const command = commandToString(payload.command);
    const reason = typeof payload.reason === 'string' ? payload.reason : '';
    return [
      {
        kind: 'approval',
        title: 'Command approval needed',
        body: [reason, command].filter(Boolean).join('\n'),
        input: payload,
        ts,
        uuid,
      },
    ];
  }

  if (itemType === 'turn_diff') {
    return [
      {
        kind: 'file_change',
        diff: typeof payload.unified_diff === 'string' ? payload.unified_diff : undefined,
        operation: 'diff',
        ts,
        uuid,
      },
    ];
  }

  if (itemType === 'turn_aborted' || itemType === 'turn_failed') {
    return [
      {
        kind: 'event',
        title: itemType === 'turn_aborted' ? 'Turn aborted' : 'Turn failed',
        body: extractText(payload.error ?? payload.message) || itemType,
        tone: 'danger',
        ts,
        uuid,
      },
    ];
  }

  if (itemType === 'thread_name_updated') {
    const title = typeof payload.thread_name === 'string' ? payload.thread_name : '';
    return title
      ? [{ kind: 'event', title: 'Session renamed', body: title, tone: 'muted', ts, uuid }]
      : [];
  }

  if (itemType === 'token_count') {
    return [
      {
        kind: 'usage',
        inputTokens: numberOrUndefined(payload.input_tokens ?? payload.inputTokens),
        outputTokens: numberOrUndefined(payload.output_tokens ?? payload.outputTokens),
        totalTokens: numberOrUndefined(payload.total_tokens ?? payload.totalTokens),
        ts,
        uuid,
      },
    ];
  }

  return [
    {
      kind: 'event',
      title: `Provider event: ${itemType || 'unknown'}`,
      body: safeJsonPreview(payload),
      tone: 'muted',
      ts,
      uuid,
    },
  ];
}

function parseCodexCompactedEntry(e: Record<string, unknown>): RichSessionMessage[] | null {
  if (e.type !== 'compacted') return null;
  const payload =
    typeof e.payload === 'object' && e.payload !== null
      ? (e.payload as Record<string, unknown>)
      : null;
  const replacementHistory = payload?.replacement_history;
  if (!Array.isArray(replacementHistory)) return [];

  const ts = timestampFromEntry(e, payload ?? undefined);
  const blocks: RichSessionMessage[] = [];

  for (let index = 0; index < replacementHistory.length; index += 1) {
    const item = replacementHistory[index];
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'message') continue;
    const role = normalizeCodexRole(record.role);
    if (!role) continue;
    const text = extractCodexCompactedMessageText(record.content);
    if (!text) continue;
    blocks.push({
      kind: 'text',
      role,
      text,
      ts,
      uuid: `codex-compacted-${ts}-${index}`,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text from a tool_result content field.
 * Content can be a string, an array of text blocks, or absent.
 */
function extractToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (typeof item === 'object' && item !== null) {
        const c = item as Record<string, unknown>;
        if (c.type === 'text' && typeof c.text === 'string') {
          parts.push(c.text);
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}

function viewportCliEventsFromOutput(output: string, ts: string, uuidPrefix: string): RichSessionMessage[] {
  const payload = parseViewportCliJson(output);
  if (!payload) return [];
  const schemaVersion = typeof payload.schema_version === 'string' ? payload.schema_version : '';
  const ok = payload.ok !== false;

  if (schemaVersion === 'viewport.cli.context_propose/v1') {
    const candidateId = stringField(payload, 'candidate_id');
    const providerId = stringField(payload, 'provider_id');
    const status = stringField(payload, 'status') || (ok ? 'pending_review' : 'not_queued');
    const digest = stringField(payload, 'payload_digest');
    return [
      {
        kind: 'event',
        title: ok ? 'Context candidate proposed' : 'Context proposal did not queue',
        body: [
          candidateId ? `candidate ${candidateId}` : null,
          providerId ? `provider ${providerId}` : null,
          status ? `status ${status}` : null,
          digest ? digest : null,
        ]
          .filter(Boolean)
          .join('\n'),
        tone: ok ? 'warning' : 'muted',
        ts,
        uuid: `${uuidPrefix}:context-propose:${candidateId || status || schemaVersion}`,
      },
    ];
  }

  if (schemaVersion === 'viewport.cli.context_search/v1') {
    const count = numberOrUndefined(payload.result_count ?? payload.count);
    return [
      {
        kind: 'event',
        title: 'Context searched',
        body:
          typeof count === 'number'
            ? `${count.toLocaleString()} result${count === 1 ? '' : 's'}`
            : 'Context search completed',
        tone: 'muted',
        ts,
        uuid: `${uuidPrefix}:context-search`,
      },
    ];
  }

  if (schemaVersion === 'viewport.cli.context_get/v1') {
    return [
      {
        kind: 'event',
        title: 'Context loaded',
        body: stringField(payload, 'provider_id') || 'Context item loaded',
        tone: 'muted',
        ts,
        uuid: `${uuidPrefix}:context-get`,
      },
    ];
  }

  if (schemaVersion === 'viewport.cli.context_use/v1') {
    const providerId = stringField(payload, 'provider_id');
    return [
      {
        kind: 'event',
        title: 'Context attached to repo',
        body: providerId ? `provider ${providerId}` : 'Context provider attached',
        tone: ok ? 'success' : 'warning',
        ts,
        uuid: `${uuidPrefix}:context-use:${providerId || schemaVersion}`,
      },
    ];
  }

  if (schemaVersion === 'viewport.cli.context_create/v1') {
    const vaultId = stringField(payload, 'vault_id') || stringField(payload, 'id');
    return [
      {
        kind: 'event',
        title: 'Context vault created',
        body: vaultId ? `vault ${vaultId}` : 'Context vault created',
        tone: ok ? 'success' : 'warning',
        ts,
        uuid: `${uuidPrefix}:context-create:${vaultId || schemaVersion}`,
      },
    ];
  }

  if (schemaVersion === 'viewport.cli.session_manifest/v1') {
    return [
      {
        kind: 'event',
        title: 'Viewport repo config read',
        body: stringField(payload, 'manifest_digest') || 'Session manifest resolved',
        tone: 'muted',
        ts,
        uuid: `${uuidPrefix}:session-manifest`,
      },
    ];
  }

  return [];
}

function viewportPlanEventsFromText(text: string, ts: string, uuidPrefix: string): RichSessionMessage[] {
  const payload = parseViewportPlanPayload(text);
  if (!payload) return [];
  const schema = stringField(payload, 'schema');
  if (schema !== 'viewport.plan_proposal/v1') return [];
  const title = stringField(payload, 'title') || 'Plan proposal';
  const summary = stringField(payload, 'summary');
  const source = stringField(payload, 'source');
  const body = [summary, source ? `source ${source}` : null].filter(Boolean).join('\n');
  return [
    {
      kind: 'event',
      title: `Plan draft emitted: ${title}`,
      body: body || 'A Viewport plan proposal block was emitted for trusted-edge capture.',
      tone: 'warning',
      ts,
      uuid: `${uuidPrefix}:${title}`,
    },
  ];
}

function parseViewportPlanPayload(text: string): Record<string, unknown> | null {
  const fence = /```viewport-plan\s*\n([\s\S]*?)```/i.exec(text);
  const comment = /<!--\s*viewport-plan\s*\n([\s\S]*?)-->/i.exec(text);
  const raw = fence?.[1] ?? comment?.[1];
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.includes('viewport.plan_proposal/v1')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // YAML-frontmatter style plan blocks are allowed elsewhere. The session
    // reader keeps them as normal transcript text until a structured parser is
    // needed for timeline links.
  }
  return null;
}

function parseViewportCliJson(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed.includes('schema_version')) return null;
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep trying the next candidate.
    }
  }
  return null;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === 'string' ? value.trim() : '';
}

function timestampFromEntry(
  entry: Record<string, unknown>,
  payload?: Record<string, unknown>,
): string {
  const fromPayload = payload?.timestamp;
  if (typeof fromPayload === 'string' && fromPayload) return fromPayload;
  const fromEntry = entry.timestamp;
  if (typeof fromEntry === 'string' && fromEntry) return fromEntry;
  return new Date().toISOString();
}

function normalizeCodexRole(value: unknown): 'user' | 'assistant' | null {
  if (value === 'user') return 'user';
  if (value === 'assistant') return 'assistant';
  return null;
}

function codexToolId(payload: Record<string, unknown>): string {
  const candidates = [payload.call_id, payload.callId, payload.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return '';
}

function codexUuid(payload: Record<string, unknown>, ts: string, suffix: string): string {
  const candidates = [payload.id, payload.call_id, payload.callId];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return `codex-${suffix}-${ts}`;
}

function parseCodexFunctionCallInput(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function extractCodexContentText(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed;
  }
  if (typeof value !== 'object' || value === null) return '';
  const rec = value as Record<string, unknown>;
  const candidates = [rec.text, rec.output_text, rec.input_text, rec.value, rec.content];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function extractCodexCompactedMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const text = extractCodexContentText(item);
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

function extractCodexReasoning(payload: Record<string, unknown>): string {
  const summary = payload.summary;
  if (Array.isArray(summary)) {
    const pieces: string[] = [];
    for (const item of summary) {
      if (typeof item === 'string' && item.trim()) {
        pieces.push(item.trim());
        continue;
      }
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const text = extractCodexContentText(rec);
      if (text) pieces.push(text);
    }
    if (pieces.length > 0) return pieces.join('\n');
  }
  const fallback = extractCodexContentText(payload);
  return fallback;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (!value || typeof value !== 'object') return '';
  const rec = value as Record<string, unknown>;
  const candidates = [
    rec.text,
    rec.output_text,
    rec.input_text,
    rec.value,
    rec.content,
    rec.message,
  ];
  for (const candidate of candidates) {
    const text = extractText(candidate);
    if (text) return text;
  }
  return '';
}

function commandToString(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((part) => String(part))
      .join(' ')
      .trim();
  }
  if (typeof value === 'string') return value.trim();
  return '';
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = numberOrNull(value);
  return n === null ? undefined : n;
}

function durationToMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  return (
    numberOrNull(rec.ms) ??
    numberOrNull(rec.millis) ??
    numberOrNull(rec.milliseconds) ??
    (typeof rec.secs === 'number' ? rec.secs * 1000 : null)
  );
}

function safeJsonPreview(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json.length > 2_000 ? `${json.slice(0, 2_000)}…` : json;
  } catch {
    return String(value);
  }
}
