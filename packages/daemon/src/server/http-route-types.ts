export interface DaemonRuntimeInfo {
  pid: number;
  host: string;
  port: number;
  listen?: string;
  socketPath?: string;
  startedAt: number;
  version: string;
  relayEnabled?: boolean;
}
