import { getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { previewContextCandidate } from '../context/local-edge-candidates.js';

export async function contextCandidatePreview(): Promise<void> {
  const contextResourceId = requiredContextId(
    'vpd context candidate-preview --context <id> --event <event-id> --device <name>',
  );
  const candidate = await previewContextCandidate({
    contextResourceId,
    actorName:
      getFlag('actor') ??
      requiredFlag('device', 'vpd context candidate-preview --context <id> --device <name>'),
    candidateEventId: getFlag('event') ?? getFlag('candidate-event'),
    payloadDigest: getFlag('payload-digest'),
    credentials: readCredentials({ required: false }),
  });

  if (isJsonMode()) {
    printJson({
      schema_version: 'viewport.cli.context_candidate_preview/v1',
      command: 'context candidate-preview',
      ok: true,
      candidate,
    });
    return;
  }
  console.log(`# ${candidate.title}`);
  console.log(candidate.body);
}

function readCredentials(options?: { required?: boolean }): {
  passphrase: string;
  recoveryCode: string;
} {
  if (options?.required === false) {
    return {
      passphrase: getFlag('passphrase') ?? '',
      recoveryCode: getFlag('recovery-code') ?? '',
    };
  }
  return {
    passphrase: requiredFlag('passphrase', 'Missing --passphrase'),
    recoveryCode: requiredFlag('recovery-code', 'Missing --recovery-code'),
  };
}

function requiredFlag(name: string, usage: string): string {
  const value = getFlag(name);
  if (!value || value.startsWith('--')) {
    throw new Error(usage.startsWith('Missing') ? usage : `${usage} (missing --${name})`);
  }
  return value;
}

function requiredContextId(usage: string): string {
  const value = getFlag('context') ?? getFlag('project');
  if (!value || value.startsWith('--')) {
    throw new Error(`${usage} (missing --context)`);
  }
  return value;
}
