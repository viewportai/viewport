export interface RelayDiagnosticInput {
  state?: string | null;
  reconnectAttempt?: number | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}

export function relayRecoveryHint(input: RelayDiagnosticInput): string | null {
  const code = normalize(input.lastErrorCode);
  const message = normalize(input.lastErrorMessage);
  const state = normalize(input.state);

  if (!code && !message && !state) return null;
  if (state === 'connected') return null;

  if (code === 'DAEMON_KEY_REGISTER_FAILED' || message.includes('key registration failed')) {
    return 'Pairing reached the server, but daemon key registration failed. Re-pair this daemon, then restart it.';
  }

  if (
    code === 'RUNTIME_TARGET_REQUIRED' ||
    code === 'RUNTIME_TARGET_NOT_FOUND' ||
    message.includes('runtime target not found') ||
    message.includes('runtime target is missing')
  ) {
    return 'The selected runtime target is no longer active. Re-pair this machine or select a live machine in the runtime UI.';
  }

  if (
    code === 'RUNTIME_TARGET_MISMATCH' ||
    message.includes('runtime target mismatch') ||
    message.includes('different runtime target')
  ) {
    return 'The daemon is connected with a different runtime target than the browser selected. Re-pair or restart the daemon after selecting the intended runtime target.';
  }

  if (code === 'CIRCUIT_OPEN' || state === 'circuit_open') {
    return 'Relay reconnects are paused after repeated failures. Check relay/server health, then run `vpd restart`.';
  }

  if (code === 'UNPAIRED' || message.includes('pair')) {
    return 'This daemon is not paired with a workspace. Run `vpd pair <code> --server <url>`.';
  }

  if (
    code.includes('ECONNREFUSED') ||
    code.includes('ENOTFOUND') ||
    code.includes('ETIMEDOUT') ||
    message.includes('fetch failed') ||
    message.includes('connection refused') ||
    message.includes('timeout')
  ) {
    return 'The daemon cannot reach the relay/server endpoint. Verify the server URL, relay URL, TLS, and local network.';
  }

  if (state === 'waiting_retry' || state === 'connecting') {
    return 'Relay is retrying. If it does not connect soon, run `vpd status --json` and check the relay/server logs.';
  }

  return 'Relay is not connected. Check `Relay last`, server URL, relay URL, and pairing state.';
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}
