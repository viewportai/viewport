import type { WebSocket as WsType } from 'ws';
import WebSocket from 'ws';
import { computeBackoffMs, sleep } from './bridge-backoff.js';
import {
  CIRCUIT_BREAKER_MS,
  DEFAULT_MAX_PENDING_OUTBOUND,
  DEFAULT_MAX_PENDING_OUTBOUND_BYTES,
  ISSUE_FAILURE_THRESHOLD,
  RELAY_KEY_ROTATE_AFTER_MESSAGES,
  RELAY_REPLAY_WINDOW,
  RELAY_SESSION_IDLE_TTL_MS,
} from './bridge-constants.js';
import {
  decryptEnvelope,
  encryptEnvelope,
  fromBase64Url,
  parseRelayEnvelope,
  toBase64Url,
} from './bridge-crypto.js';
import { logDaemonFrameSummary } from './bridge-frame-logger.js';
import { isCompatibleProfile } from './bridge-handshake-profile.js';
import {
  deriveSessionFromKeyExchange,
  type DaemonRelayIdentity,
  loadOrCreateIdentity,
  parseRelayKeyExchangeInitFrame,
  type RelayHandshakeProfile,
  type RelayKeyExchangeInitFrame,
} from './bridge-key-exchange.js';
import {
  deriveNoiseV3SessionFromInit,
  parseRelayKeyExchangeInitFrameV3,
  type RelayKeyExchangeInitFrameV3,
} from './bridge-noise-v3.js';
import { BridgeError, type BridgeErrorCode } from './bridge-errors.js';
import { closeQuietly, resolveRelayTlsOptions, wsOpen } from './bridge-network.js';
import {
  handleRelayPairingOfferRequest,
  handleRelayPairingRedeemRequest,
  pruneRelayPairingChannelKeys,
  type PairingChannelKey,
} from './bridge-pairing-control-handler.js';
import { RelayTokenIssuer } from './bridge-token-issuer.js';
import {
  isRelayControlFrame,
  parsePairingOfferRequestFrame,
  parsePairingRedeemRequestFrame,
  type RelayControlFrame,
  type RelayKeyUpdateRequiredFrame,
  type RelayPairingOfferRequestFrame,
  type RelayPairingRedeemRequestFrame,
} from './relay-control-frames.js';
import { resolveRelayPairingSecret } from '../server/pairing-offers.js';
import { ConfigManager } from '../core/config.js';
import { logger as out } from '../core/output.js';
import { transportFetch } from '../cli/network.js';

export interface DaemonRelayBridgeOptions {
  relayEndpoint: string;
  relayServerUrl: string;
  workspaceId: string;
  projectMachineBindingId?: string;
  machineId?: string;
  issueToken?: string;
  daemonWsUrl: string;
  daemonAuthToken?: string;
  daemonTlsVerify?: 'auto' | '0' | '1';
  daemonCaCertPath?: string;
  daemonTlsPins?: string[];
  relayTlsVerify?: 'auto' | '0' | '1';
  relayCaCertPath?: string;
  relayTlsPins?: string[];
  relayTokenIssuer?: string;
  relayTokenAudience?: string;
  relayTokenJwksUrl?: string;
  relayTokenSigningKeys?: Record<string, string>;
  relayTokenClockSkewSec?: number;
  maxPendingOutbound?: number;
  maxPendingOutboundBytes?: number;
  keyRotateAfterMessages?: number;
  pairingChannelTtlMs?: number;
  pairingChannelMaxEntries?: number;
  relaySessionMaxEntries?: number;
}

interface RelaySessionState {
  key: Buffer;
  profile: RelayHandshakeProfile;
  sessionId: string;
  epoch: number;
  txSeq: number;
  rxHighestSeq: number;
  rxSeenSeq: Set<number>;
  lastActivityAt: number;
  keyRotationRequested: boolean;
}

type RelayWs = WsType;

export { CIRCUIT_BREAKER_MS } from './bridge-constants.js';
export { computeBackoffMs, decryptEnvelope, encryptEnvelope, fromBase64Url, toBase64Url };

const DEFAULT_PAIRING_CHANNEL_TTL_MS = 10 * 60_000;
const DEFAULT_PAIRING_CHANNEL_MAX_ENTRIES = 2_048;
const DEFAULT_RELAY_SESSION_MAX_ENTRIES = 4_096;

export interface DaemonRelayBridgeStatus {
  state: 'stopped' | 'connecting' | 'connected' | 'waiting_retry' | 'circuit_open';
  reconnectAttempt: number;
  lastErrorCode?: BridgeErrorCode;
  lastErrorMessage?: string;
  lastErrorAt?: number;
  circuitOpenUntil?: number;
}

export class DaemonRelayBridge {
  private relayWs: RelayWs | null = null;
  private daemonWs: RelayWs | null = null;
  private running = false;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private readonly pendingOutbound: string[] = [];
  private pendingOutboundBytes = 0;
  private daemonIdentity: DaemonRelayIdentity | null = null;
  private daemonIssueToken: string | null;
  private requiredProfile: RelayHandshakeProfile = 'noise-ik';
  private readonly relayTokenIssuer: RelayTokenIssuer;
  private readonly relaySessions = new Map<string, RelaySessionState>();
  private readonly pairingChannelKeys = new Map<string, PairingChannelKey>();
  private consecutiveIssueFailures = 0;
  private circuitOpenUntilMs = 0;
  private lastErrorCode: BridgeErrorCode | undefined;
  private lastErrorMessage: string | undefined;
  private lastErrorAt: number | undefined;
  private state: DaemonRelayBridgeStatus['state'] = 'stopped';
  private relayEndpoint: string;
  private readonly keyRotateAfterMessages: number;
  private readonly pairingChannelTtlMs: number;
  private readonly pairingChannelMaxEntries: number;
  private readonly relaySessionMaxEntries: number;

  constructor(private readonly options: DaemonRelayBridgeOptions) {
    this.relayEndpoint = options.relayEndpoint;
    this.keyRotateAfterMessages =
      typeof options.keyRotateAfterMessages === 'number' &&
      Number.isInteger(options.keyRotateAfterMessages) &&
      options.keyRotateAfterMessages >= 1
        ? options.keyRotateAfterMessages
        : RELAY_KEY_ROTATE_AFTER_MESSAGES;
    this.pairingChannelTtlMs =
      typeof options.pairingChannelTtlMs === 'number' &&
      Number.isInteger(options.pairingChannelTtlMs) &&
      options.pairingChannelTtlMs >= 1_000
        ? options.pairingChannelTtlMs
        : DEFAULT_PAIRING_CHANNEL_TTL_MS;
    this.pairingChannelMaxEntries =
      typeof options.pairingChannelMaxEntries === 'number' &&
      Number.isInteger(options.pairingChannelMaxEntries) &&
      options.pairingChannelMaxEntries >= 1
        ? options.pairingChannelMaxEntries
        : DEFAULT_PAIRING_CHANNEL_MAX_ENTRIES;
    this.relaySessionMaxEntries =
      typeof options.relaySessionMaxEntries === 'number' &&
      Number.isInteger(options.relaySessionMaxEntries) &&
      options.relaySessionMaxEntries >= 1
        ? options.relaySessionMaxEntries
        : DEFAULT_RELAY_SESSION_MAX_ENTRIES;
    this.daemonIssueToken = options.issueToken ?? null;
    this.relayTokenIssuer = new RelayTokenIssuer(options, this.daemonIssueToken);
  }

  getStatus(): DaemonRelayBridgeStatus {
    return {
      state: this.state,
      reconnectAttempt: this.reconnectAttempt,
      lastErrorCode: this.lastErrorCode,
      lastErrorMessage: this.lastErrorMessage,
      lastErrorAt: this.lastErrorAt,
      circuitOpenUntil: this.circuitOpenUntilMs > 0 ? this.circuitOpenUntilMs : undefined,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempt = 0;
    this.state = 'connecting';
    await this.connectLoop('start');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.reconnecting = false;
    closeQuietly(this.relayWs);
    closeQuietly(this.daemonWs);
    this.relayWs = null;
    this.daemonWs = null;
    this.pendingOutbound.length = 0;
    this.pendingOutboundBytes = 0;
    this.relaySessions.clear();
    this.pairingChannelKeys.clear();
    this.state = 'stopped';
  }

  private async ensureKeyMaterial(): Promise<void> {
    if (!this.daemonIdentity) {
      this.daemonIdentity = await loadOrCreateIdentity();
    }
  }

  private async registerDaemonPublicKeyWithIdentity(identity: DaemonRelayIdentity): Promise<void> {
    if (!identity) {
      throw new BridgeError('DAEMON_KEY_REGISTER_FAILED', 'daemon identity unavailable');
    }

    const url =
      `${this.options.relayServerUrl.replace(/\/+$/, '')}` +
      `/api/runtime/workspaces/${encodeURIComponent(this.options.workspaceId)}/daemon-key`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    let res: Response;
    try {
      res = await transportFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          credential: this.daemonIssueToken ?? undefined,
          daemonPublicKey: identity.publicKey,
          projectMachineBindingId: this.options.projectMachineBindingId,
        }),
        signal: controller.signal,
        tlsVerify: this.options.relayTlsVerify ?? 'auto',
        caCertPath: this.options.relayCaCertPath,
        tlsPins: this.options.relayTlsPins,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new BridgeError(
        'DAEMON_KEY_REGISTER_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
    clearTimeout(timeout);

    const parsed = (await res.json().catch(() => null)) as {
      ok?: boolean;
      reason?: string;
      error?: string;
      daemonIssueToken?: string;
    } | null;

    if (!res.ok || !parsed?.ok) {
      const reason = parsed?.reason ?? parsed?.error ?? `HTTP ${res.status}`;
      throw new BridgeError(
        'DAEMON_KEY_REGISTER_FAILED',
        `daemon key registration failed: ${reason}`,
      );
    }
    if (!parsed?.daemonIssueToken || parsed.daemonIssueToken.trim().length === 0) {
      if (this.daemonIssueToken && this.daemonIssueToken.trim().length > 0) {
        return;
      }
      throw new BridgeError(
        'DAEMON_KEY_REGISTER_FAILED',
        'daemon key registration succeeded but daemon issue token was missing',
      );
    }
    this.daemonIssueToken = parsed.daemonIssueToken;
    this.relayTokenIssuer.setDaemonIssueToken(parsed.daemonIssueToken);
    await this.persistIssueToken(parsed.daemonIssueToken);
  }

  private async registerDaemonPublicKey(): Promise<void> {
    if (!this.daemonIdentity) {
      throw new BridgeError('DAEMON_KEY_REGISTER_FAILED', 'daemon identity unavailable');
    }
    await this.registerDaemonPublicKeyWithIdentity(this.daemonIdentity);
  }

  private async persistIssueToken(issueToken: string): Promise<void> {
    const normalized = issueToken.trim();
    if (normalized.length === 0) return;
    try {
      const manager = new ConfigManager();
      await manager.load();
      const daemonConfig = manager.getDaemonConfig() ?? {};
      const relayConfig = daemonConfig.relay ?? {};
      await manager.setDaemonConfig({
        ...daemonConfig,
        relay: {
          ...relayConfig,
          issueToken: normalized,
        },
      });
    } catch (error) {
      out.warn(
        `[relay] failed to persist daemon issue token: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async connectLoop(reason: string): Promise<void> {
    if (!this.running) return;
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.state = 'connecting';

    try {
      const now = Date.now();
      if (this.circuitOpenUntilMs > now) {
        const waitMs = this.circuitOpenUntilMs - now;
        this.state = 'circuit_open';
        this.reportStatus('CIRCUIT_OPEN', `circuit open, waiting ${waitMs}ms before retry`);
        await sleep(waitMs);
      }

      this.reconnectAttempt += 1;
      const attempt = this.reconnectAttempt;
      out.log(`[relay] daemon bridge connect attempt ${attempt} (${reason})`);

      await this.ensureKeyMaterial();
      await this.registerDaemonPublicKey();

      const issue = await this.issueRelayToken();
      if (!issue.relayToken) {
        throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token response missing relayToken');
      }

      this.requiredProfile = issue.profile;
      this.relaySessions.clear();

      this.consecutiveIssueFailures = 0;
      this.circuitOpenUntilMs = 0;

      const daemonHeaders: Record<string, string> = {};
      if (this.options.daemonAuthToken) {
        daemonHeaders.authorization = `Bearer ${this.options.daemonAuthToken}`;
      }
      const daemonTlsOptions = resolveRelayTlsOptions(
        this.options.daemonWsUrl,
        this.options.daemonTlsVerify ?? 'auto',
        this.options.daemonCaCertPath,
        this.options.daemonTlsPins,
      );
      const daemonWs = new WebSocket(this.options.daemonWsUrl, {
        ...daemonTlsOptions,
        headers: Object.keys(daemonHeaders).length > 0 ? daemonHeaders : undefined,
      });
      await wsOpen(daemonWs);
      this.daemonWs = daemonWs;

      const relayUrl =
        `${this.relayEndpoint}?role=workspace-daemon` +
        `&workspaceId=${encodeURIComponent(this.options.workspaceId)}` +
        (this.options.projectMachineBindingId
          ? `&projectMachineBindingId=${encodeURIComponent(this.options.projectMachineBindingId)}`
          : '');

      const relayTlsOptions = resolveRelayTlsOptions(
        relayUrl,
        this.options.relayTlsVerify ?? 'auto',
        this.options.relayCaCertPath,
        this.options.relayTlsPins,
      );
      const relayWs = new WebSocket(relayUrl, {
        ...relayTlsOptions,
        headers: {
          authorization: `Bearer ${issue.relayToken}`,
        },
      });
      await wsOpen(relayWs);
      this.relayWs = relayWs;

      out.log('[relay] daemon bridge connected');
      this.state = 'connected';
      this.reconnectAttempt = 0;
      this.installSocketHandlers(daemonWs, relayWs);
      this.flushPendingOutbound();
    } catch (error) {
      closeQuietly(this.relayWs);
      closeQuietly(this.daemonWs);
      this.relayWs = null;
      this.daemonWs = null;
      this.relaySessions.clear();

      const bridgeError = this.normalizeError(error);
      this.recordError(bridgeError.code, bridgeError.message);
      out.warn(
        `[relay] daemon bridge connect failed [${bridgeError.code}]: ${bridgeError.message}`,
      );

      if (
        bridgeError.code === 'TOKEN_ISSUE_FAILED' ||
        bridgeError.code === 'TOKEN_RESPONSE_INVALID' ||
        bridgeError.code === 'DAEMON_KEY_REGISTER_FAILED'
      ) {
        this.consecutiveIssueFailures += 1;
        if (this.consecutiveIssueFailures >= ISSUE_FAILURE_THRESHOLD) {
          this.circuitOpenUntilMs = Date.now() + CIRCUIT_BREAKER_MS;
          this.reportStatus(
            'CIRCUIT_OPEN',
            `opened after ${this.consecutiveIssueFailures} consecutive control-plane failures`,
          );
        }
      }

      if (this.running) {
        const waitMs = computeBackoffMs(this.reconnectAttempt);
        out.log(`[relay] daemon bridge reconnect in ${waitMs}ms`);
        this.state = 'waiting_retry';
        await sleep(waitMs);
        this.reconnecting = false;
        await this.connectLoop('retry');
        return;
      }
    }

    this.reconnecting = false;
  }

  private installSocketHandlers(daemonWs: RelayWs, relayWs: RelayWs): void {
    daemonWs.on('message', (raw) => {
      const payload = raw.toString('utf8');
      logDaemonFrameSummary('daemon->relay', payload);
      if (relayWs.readyState === WebSocket.OPEN) {
        this.sendToAllRelaySessions(relayWs, payload);
        return;
      }
      const payloadBytes = Buffer.byteLength(payload);
      this.pendingOutbound.push(payload);
      this.pendingOutboundBytes += payloadBytes;
      const maxPendingOutbound = this.options.maxPendingOutbound ?? DEFAULT_MAX_PENDING_OUTBOUND;
      const maxPendingBytes =
        this.options.maxPendingOutboundBytes ?? DEFAULT_MAX_PENDING_OUTBOUND_BYTES;
      while (
        this.pendingOutbound.length > maxPendingOutbound ||
        this.pendingOutboundBytes > maxPendingBytes
      ) {
        const dropped = this.pendingOutbound.shift();
        if (!dropped) break;
        this.pendingOutboundBytes -= Buffer.byteLength(dropped);
      }
    });

    relayWs.on('message', async (raw) => {
      const text = raw.toString('utf8');

      const handledControl = await this.handleRelayControlFrame(text, relayWs, daemonWs);
      if (handledControl) return;

      let envelope;
      try {
        envelope = parseRelayEnvelope(text);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.recordError('ENVELOPE_DECRYPT_FAILED', msg);
        out.warn(`[relay] invalid relay envelope [ENVELOPE_DECRYPT_FAILED]: ${msg}`);
        return;
      }

      const session = this.relaySessions.get(envelope.sessionId);
      if (!session) return;
      if (session.profile !== envelope.profile || session.epoch !== envelope.epoch) return;
      if (!this.acceptInboundSeq(session, envelope.seq)) {
        out.warn(`[relay] dropped replay/old frame for session ${session.sessionId}`);
        return;
      }

      try {
        const plaintext = decryptEnvelope(session.key, envelope);
        session.lastActivityAt = Date.now();
        logDaemonFrameSummary('relay->daemon', plaintext);
        if (daemonWs.readyState === WebSocket.OPEN) {
          daemonWs.send(plaintext);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.recordError('ENVELOPE_DECRYPT_FAILED', msg);
        out.warn(`[relay] failed to decrypt relay payload [ENVELOPE_DECRYPT_FAILED]: ${msg}`);
      }
    });

    const reconnect = (source: string) => {
      if (!this.running) return;
      if (this.reconnecting) return;
      this.recordError('WEBSOCKET_ERROR', `${source} disconnected`);
      out.warn(`[relay] ${source} disconnected; reconnecting`);
      closeQuietly(relayWs);
      closeQuietly(daemonWs);
      this.relayWs = null;
      this.daemonWs = null;
      this.relaySessions.clear();
      this.state = 'waiting_retry';
      void this.connectLoop(source);
    };

    relayWs.on('close', () => reconnect('relay'));
    daemonWs.on('close', () => reconnect('daemon'));
    relayWs.on('error', (err) => out.warn(`[relay] relay ws error: ${err.message}`));
    daemonWs.on('error', (err) => out.warn(`[relay] daemon ws error: ${err.message}`));
  }

  private sendToAllRelaySessions(relayWs: RelayWs, payload: string): void {
    this.pruneIdleSessions();
    for (const session of this.relaySessions.values()) {
      this.sendToRelaySession(relayWs, session, payload);

      if (!session.keyRotationRequested && session.txSeq >= this.keyRotateAfterMessages) {
        const rotateNotice: RelayKeyUpdateRequiredFrame = {
          type: 'relay_key_update_required',
          sessionId: session.sessionId,
          nextEpoch: session.epoch + 1,
          reason: 'message_threshold',
        };
        relayWs.send(JSON.stringify(rotateNotice));
        session.keyRotationRequested = true;
      }
    }
  }

  private sendToRelaySession(relayWs: RelayWs, session: RelaySessionState, payload: string): void {
    session.txSeq += 1;
    session.lastActivityAt = Date.now();
    const envelope = encryptEnvelope(session.key, payload, {
      profile: session.profile,
      sessionId: session.sessionId,
      epoch: session.epoch,
      seq: session.txSeq,
    });
    relayWs.send(envelope);
  }

  private acceptInboundSeq(session: RelaySessionState, seq: number): boolean {
    if (seq < 1) return false;
    if (session.rxSeenSeq.has(seq)) return false;
    if (seq > session.rxHighestSeq + RELAY_REPLAY_WINDOW) return false;
    const minimumAllowed = Math.max(1, session.rxHighestSeq - RELAY_REPLAY_WINDOW + 1);
    if (seq < minimumAllowed) return false;

    session.rxSeenSeq.add(seq);
    if (seq > session.rxHighestSeq) session.rxHighestSeq = seq;

    const pruneBelow = Math.max(1, session.rxHighestSeq - RELAY_REPLAY_WINDOW + 1);
    for (const seen of session.rxSeenSeq) {
      if (seen < pruneBelow) session.rxSeenSeq.delete(seen);
    }
    return true;
  }

  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.relaySessions.entries()) {
      if (now - session.lastActivityAt > RELAY_SESSION_IDLE_TTL_MS) {
        this.relaySessions.delete(sessionId);
      }
    }
  }

  private enforceRelaySessionCapacity(): void {
    this.pruneIdleSessions();
    while (this.relaySessions.size > this.relaySessionMaxEntries) {
      const oldestSessionId = this.relaySessions.keys().next().value;
      if (!oldestSessionId) break;
      this.relaySessions.delete(oldestSessionId);
      out.warn(
        `[relay] evicted relay session ${oldestSessionId} due to relay session cap (${this.relaySessionMaxEntries})`,
      );
    }
  }

  private async handleRelayControlFrame(
    text: string,
    relayWs: RelayWs,
    daemonWs: RelayWs,
  ): Promise<boolean> {
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(text);
    } catch {
      return false;
    }

    const pairingOfferRequest = parsePairingOfferRequestFrame(parsedUnknown);
    if (pairingOfferRequest) {
      await this.handlePairingOfferRequest(pairingOfferRequest, relayWs);
      return true;
    }

    const pairingRedeemRequest = parsePairingRedeemRequestFrame(parsedUnknown);
    if (pairingRedeemRequest) {
      await this.handlePairingRedeemRequest(pairingRedeemRequest, relayWs);
      return true;
    }

    const keyExchangeInitV3 = parseRelayKeyExchangeInitFrameV3(parsedUnknown);
    if (keyExchangeInitV3) {
      await this.handleKeyExchangeInitV3(keyExchangeInitV3, relayWs);
      return true;
    }

    const keyExchangeInit = parseRelayKeyExchangeInitFrame(parsedUnknown);
    if (keyExchangeInit) {
      await this.handleKeyExchangeInit(keyExchangeInit, relayWs);
      return true;
    }

    if (!isRelayControlFrame(parsedUnknown)) {
      return false;
    }
    const parsed = parsedUnknown as RelayControlFrame;

    if (parsed.type === 'relay_status') {
      if (
        parsed.code === 'RELAY_REDIRECT' &&
        typeof parsed.relayWsBaseUrl === 'string' &&
        parsed.relayWsBaseUrl.trim().length > 0 &&
        parsed.relayWsBaseUrl !== this.relayEndpoint
      ) {
        this.relayEndpoint = parsed.relayWsBaseUrl;
        this.recordError('WEBSOCKET_ERROR', `relay redirect requested: ${parsed.relayWsBaseUrl}`);
        out.log(`[relay] redirecting daemon bridge to ${parsed.relayWsBaseUrl}`);
        closeQuietly(relayWs);
        closeQuietly(daemonWs);
        return true;
      }
      out.log(
        `[relay] status ${parsed.code ?? 'UNKNOWN'}: ${parsed.message ?? 'no additional detail'}`,
      );
      return true;
    }

    if (parsed.type === 'relay_key_update_required') {
      const session = this.relaySessions.get(parsed.sessionId);
      if (!session) {
        out.warn(`[relay] key update request ignored for unknown session ${parsed.sessionId}`);
        return true;
      }
      if (!Number.isInteger(parsed.nextEpoch) || parsed.nextEpoch !== session.epoch + 1) {
        out.warn(
          `[relay] key update request rejected for session ${parsed.sessionId}: invalid nextEpoch=${parsed.nextEpoch} expected=${session.epoch + 1}`,
        );
        return true;
      }
      session.keyRotationRequested = true;
      return true;
    }

    return true;
  }

  private async handleKeyExchangeInit(
    init: RelayKeyExchangeInitFrame,
    relayWs: RelayWs,
  ): Promise<void> {
    if (!this.daemonIdentity) {
      out.warn('[relay] key exchange init ignored: daemon identity not ready');
      return;
    }

    if (!isCompatibleProfile(this.requiredProfile, init.profile)) {
      out.warn(
        `[relay] key exchange profile mismatch (got=${init.profile}, expected=${this.requiredProfile})`,
      );
      return;
    }

    let previous: RelaySessionState | undefined;
    let nextEpoch = 1;
    if (init.previousSessionId) {
      previous = this.relaySessions.get(init.previousSessionId);
      if (!previous) {
        out.warn(
          `[relay] key exchange rejected: unknown previous session ${init.previousSessionId}`,
        );
        return;
      }
      if (previous.profile !== init.profile) {
        out.warn(
          `[relay] key exchange rejected: profile mismatch for previous session ${init.previousSessionId}`,
        );
        return;
      }
      if (!previous.keyRotationRequested) {
        out.warn(
          `[relay] key exchange rejected: previous session ${init.previousSessionId} has no pending key rotation`,
        );
        return;
      }
      nextEpoch = previous.epoch + 1;
    }

    let pairingSecret: Buffer | undefined;
    if (init.profile === 'noise-ikpsk2') {
      pairingSecret = await this.resolvePolicyCPairingSecret(init.pairingPeerId);
      if (!pairingSecret) {
        out.warn(
          `[relay] key exchange rejected: missing local pairing binding for peer ${init.pairingPeerId ?? '<none>'}`,
        );
        return;
      }
    }

    try {
      const derived = deriveSessionFromKeyExchange({
        init,
        daemonIdentity: this.daemonIdentity,
        nextEpoch,
        pairingSecret,
      });
      if (previous && init.previousSessionId) {
        this.relaySessions.delete(init.previousSessionId);
      }
      this.relaySessions.set(derived.session.sessionId, {
        ...derived.session,
        txSeq: 0,
        rxHighestSeq: 0,
        rxSeenSeq: new Set<number>(),
        lastActivityAt: Date.now(),
        keyRotationRequested: false,
      });
      this.enforceRelaySessionCapacity();
      if (relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify(derived.response));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordError('KEY_EXCHANGE_FAILED', message);
      out.warn(`[relay] key exchange failed [KEY_EXCHANGE_FAILED]: ${message}`);
    }
  }

  private async handleKeyExchangeInitV3(
    init: RelayKeyExchangeInitFrameV3,
    relayWs: RelayWs,
  ): Promise<void> {
    if (!this.daemonIdentity) {
      out.warn('[relay] noise-v3 key exchange init ignored: daemon identity not ready');
      return;
    }

    if (!isCompatibleProfile(this.requiredProfile, init.profile)) {
      out.warn(
        `[relay] noise-v3 key exchange profile mismatch (got=${init.profile}, expected=${this.requiredProfile})`,
      );
      return;
    }

    let previous: RelaySessionState | undefined;
    let nextEpoch = 1;
    if (init.previousSessionId) {
      previous = this.relaySessions.get(init.previousSessionId);
      if (!previous) {
        out.warn(
          `[relay] noise-v3 key exchange rejected: unknown previous session ${init.previousSessionId}`,
        );
        return;
      }
      if (previous.profile !== init.profile) {
        out.warn(
          `[relay] noise-v3 key exchange rejected: profile mismatch for previous session ${init.previousSessionId}`,
        );
        return;
      }
      if (!previous.keyRotationRequested) {
        out.warn(
          `[relay] noise-v3 key exchange rejected: previous session ${init.previousSessionId} has no pending key rotation`,
        );
        return;
      }
      nextEpoch = previous.epoch + 1;
    }

    let pairingSecret: Buffer | undefined;
    if (init.profile === 'noise-ikpsk2') {
      pairingSecret = await this.resolvePolicyCPairingSecret(init.pairingPeerId);
      if (!pairingSecret) {
        out.warn(
          `[relay] noise-v3 key exchange rejected: missing local pairing binding for peer ${init.pairingPeerId ?? '<none>'}`,
        );
        return;
      }
    }

    try {
      const derived = deriveNoiseV3SessionFromInit({
        init,
        daemonIdentity: this.daemonIdentity,
        nextEpoch,
        pairingSecret,
      });
      if (previous && init.previousSessionId) {
        this.relaySessions.delete(init.previousSessionId);
      }
      this.relaySessions.set(derived.session.sessionId, {
        ...derived.session,
        profile: derived.session.profile as RelayHandshakeProfile,
        txSeq: 0,
        rxHighestSeq: 0,
        rxSeenSeq: new Set<number>(),
        lastActivityAt: Date.now(),
        keyRotationRequested: false,
      });
      this.enforceRelaySessionCapacity();
      if (relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify(derived.response));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordError('KEY_EXCHANGE_FAILED', message);
      out.warn(`[relay] noise-v3 key exchange failed [KEY_EXCHANGE_FAILED]: ${message}`);
    }
  }

  private async handlePairingOfferRequest(
    frame: RelayPairingOfferRequestFrame,
    relayWs: RelayWs,
  ): Promise<void> {
    const reply = (payload: Record<string, unknown>): void => {
      if (relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify(payload));
      }
    };
    await handleRelayPairingOfferRequest({
      frame,
      reply,
      pairingChannelKeys: this.pairingChannelKeys,
      workspaceId: this.options.workspaceId,
      daemonWsUrl: this.options.daemonWsUrl,
      maxAgeMs: this.pairingChannelTtlMs,
      maxEntries: this.pairingChannelMaxEntries,
    });
  }

  private async handlePairingRedeemRequest(
    frame: RelayPairingRedeemRequestFrame,
    relayWs: RelayWs,
  ): Promise<void> {
    const reply = (payload: Record<string, unknown>): void => {
      if (relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify(payload));
      }
    };
    await handleRelayPairingRedeemRequest({
      frame,
      reply,
      pairingChannelKeys: this.pairingChannelKeys,
      maxAgeMs: this.pairingChannelTtlMs,
      maxEntries: this.pairingChannelMaxEntries,
    });
  }

  prunePairingChannelKeys(
    now = Date.now(),
    maxAgeMs = this.pairingChannelTtlMs,
    maxEntries = this.pairingChannelMaxEntries,
  ): void {
    pruneRelayPairingChannelKeys(this.pairingChannelKeys, now, maxAgeMs, maxEntries);
  }

  private flushPendingOutbound(): void {
    const relayWs = this.relayWs;
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return;
    while (this.pendingOutbound.length > 0 && relayWs.readyState === WebSocket.OPEN) {
      const next = this.pendingOutbound.shift();
      if (!next) break;
      this.pendingOutboundBytes -= Buffer.byteLength(next);
      this.sendToAllRelaySessions(relayWs, next);
    }
    if (this.pendingOutboundBytes < 0) this.pendingOutboundBytes = 0;
  }

  private async resolvePolicyCPairingSecret(
    peerId: string | undefined,
  ): Promise<Buffer | undefined> {
    if (!peerId || peerId.trim().length === 0) {
      return undefined;
    }
    const resolved = await resolveRelayPairingSecret(peerId);
    if (!resolved || resolved.length !== 32) {
      return undefined;
    }
    return resolved;
  }

  private issueRelayToken(): Promise<{
    relayToken: string;
    profile: RelayHandshakeProfile;
  }> {
    return this.relayTokenIssuer.issue();
  }

  private normalizeError(error: unknown): BridgeError {
    if (error instanceof BridgeError) {
      return error;
    }
    if (error instanceof Error) {
      return new BridgeError('UNKNOWN', error.message);
    }
    return new BridgeError('UNKNOWN', String(error));
  }

  private recordError(code: BridgeErrorCode, message: string): void {
    this.lastErrorCode = code;
    this.lastErrorMessage = message;
    this.lastErrorAt = Date.now();
  }

  private reportStatus(code: BridgeErrorCode | 'CIRCUIT_OPEN', message: string): void {
    out.warn(`[relay] bridge-status [${code}]: ${message}`);
  }
}
