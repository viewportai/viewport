const DEFAULT_MAX_WS_CLIENTS = 500;

export function resolveMaxWsClients(
  maxClientsOverride: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof maxClientsOverride === 'number') {
    return Math.max(1, Math.floor(maxClientsOverride));
  }
  const fromEnv = Number(env['VIEWPORT_MAX_WS_CLIENTS'] ?? DEFAULT_MAX_WS_CLIENTS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_MAX_WS_CLIENTS;
}
