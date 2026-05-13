import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { buildSessionContextBlock } from '../core/session-context-prompt.js';
import { logger } from '../core/logger.js';
import type { HookEventKind, HookResponse } from './types.js';

const log = logger.child({ module: 'hook-context-injector' });
const MAX_CONTEXT_CHARS = 10_000;

export async function buildContextHookResponse(options: {
  kind: HookEventKind;
  data: Record<string, unknown>;
  cwd?: string;
}): Promise<HookResponse | null> {
  if (process.env['VIEWPORT_AUTO_CONTEXT'] === '0') return null;
  if (options.kind !== 'SessionStart' && options.kind !== 'UserPromptSubmit') return null;

  const cwd = options.cwd ?? stringValue(options.data['cwd']) ?? process.cwd();
  if (options.kind === 'SessionStart') {
    return buildSessionStartContext(options.kind, cwd);
  }

  const prompt = stringValue(options.data['prompt'])?.trim() ?? '';
  if (!prompt || shouldSkipPrompt(prompt)) return null;
  return buildUserPromptContext(options.kind, cwd, prompt);
}

async function buildSessionStartContext(
  kind: HookEventKind,
  cwd: string,
): Promise<HookResponse | null> {
  try {
    const manifest = resolveSessionResourceManifestSync({ workingDirectory: cwd });
    const providerCount = manifest.contract.contextProviders.length;
    const contextCount = manifest.resources.contexts.length;
    if (providerCount === 0 && contextCount === 0) return null;

    const proposalProvider = manifest.contract.contextProviders.find((provider) =>
      provider.capabilities.includes('propose'),
    );
    const additionalContext = [
      'Viewport context is configured for this repo.',
      'On each user prompt, Viewport may inject approved context resolved locally by the daemon.',
      'If the injected context is not enough, search explicitly with `vpd context search --path . --query "<topic>" --json`.',
      proposalProvider
        ? 'If you learn something durable that should become shared context, ask the user once before running `vpd context propose --path . --title "<title>" --body "<body>" --json`. Proposals stay pending until reviewed in Viewport Inbox.'
        : 'This repo does not currently expose a proposal-capable context provider.',
      'Never propose secrets, credentials, private customer data, or one-off task chatter as context.',
    ].join('\n');

    return {
      passthrough: false,
      hookSpecificOutput: {
        hookEventName: kind,
        additionalContext,
      },
      suppressOutput: true,
    };
  } catch (error) {
    log.debug({ err: error, cwd }, 'Skipped SessionStart context injection');
    return null;
  }
}

async function buildUserPromptContext(
  kind: HookEventKind,
  cwd: string,
  prompt: string,
): Promise<HookResponse | null> {
  try {
    const block = await buildSessionContextBlock({
      workingDirectory: cwd,
      query: prompt,
      includePendingLocal: true,
      maxVaultItems: 6,
    });
    if (!block) return null;
    return {
      passthrough: false,
      hookSpecificOutput: {
        hookEventName: kind,
        additionalContext: truncateContext(block),
      },
      suppressOutput: true,
    };
  } catch (error) {
    log.debug({ err: error, cwd }, 'Skipped UserPromptSubmit context injection');
    return null;
  }
}

function shouldSkipPrompt(prompt: string): boolean {
  const normalized = prompt.trim();
  if (normalized.length < 8) return true;
  if (/^(yes|no|ok|okay|continue|thanks?|thx)$/i.test(normalized)) return true;
  return false;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function truncateContext(value: string): string {
  if (value.length <= MAX_CONTEXT_CHARS) return value;
  return `${value.slice(0, MAX_CONTEXT_CHARS - 120)}\n\n[Viewport context truncated to ${MAX_CONTEXT_CHARS} characters. Run vpd context search for more.]`;
}
