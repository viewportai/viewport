import type { WebSocket as WsType } from 'ws';
import WebSocket from 'ws';
import { computeBackoffMs, sleep } from './bridge-backoff.js';
import { registerDaemonPublicKeyWithControlPlane } from './bridge-daemon-key-registration.js';
import {
  CIRCUIT_BREAKER_MS,
  DEFAULT_MAX_PENDING_OUTBOUND,
  DEFAULT_MAX_PENDING_OUTBOUND_BYTES,
  ISSUE_FAILURE_THRESHOLD,
  RELAY_KEY_ROTATE_AFTER_MESSAGES,
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
import {
  BridgeError,
  isControlPlaneBridgeError,
  normalizeBridgeError,
  type BridgeErrorCode,
} from './bridge-errors.js';
import { openDaemonSocket, openRelayDaemonSocket } from './bridge-connections.js';
import { closeQuietly } from './bridge-network.js';
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
  type RelayPairingOfferRequestFrame,
  type RelayPairingRedeemRequestFrame,
} from './relay-control-frames.js';
import {
  acceptInboundRelaySeq,
  createRelaySessionState,
  enforceRelaySessionCapacity,
  sendToAllRelaySessions,
  type RelaySessionState,
} from './bridge-relay-sessions.js';
import { resolveRelayPairingSecret } from '../server/pairing-offers.js';
import { logger as out } from '../core/output.js';

export interface DaemonRelayBridgeOptions {
  relayEndpoint: string;
  relayServerUrl: string;
  workspaceId: string;
  runtimeTargetId?: string;
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

  private async registerDaemonPublicKey(): Promise<void> {
    const issueToken = await registerDaemonPublicKeyWithControlPlane({
      options: this.options,
      identity: this.daemonIdentity,
      daemonIssueToken: this.daemonIssueToken,
    });
    if (issueToken && issueToken !== this.daemonIssueToken) {
      this.daemonIssueToken = issueToken;
      this.relayTokenIssuer.setDaemonIssueToken(issueToken);
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

      const daemonWs = await openDaemonSocket(this.options);
      this.daemonWs = daemonWs;

      const relayWs = await openRelayDaemonSocket({
        ...this.options,
        relayEndpoint: this.relayEndpoint,
        relayToken: issue.relayToken,
      });
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

      const bridgeError = normalizeBridgeError(error);
      this.recordError(bridgeError.code, bridgeError.message);
      out.warn(
        `[relay] daemon bridge connect failed [${bridgeError.code}]: ${bridgeError.message}`,
      );

      if (isControlPlaneBridgeError(bridgeError.code)) {
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
      if (!acceptInboundRelaySeq(session, envelope.seq)) {
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
    sendToAllRelaySessions({
      relayWs,
      sessions: this.relaySessions,
      payload,
      keyRotateAfterMessages: this.keyRotateAfterMessages,
    });
  }

  private enforceRelaySessionCapacity(): void {
    const evicted = enforceRelaySessionCapacity({
      sessions: this.relaySessions,
      maxEntries: this.relaySessionMaxEntries,
    });
    for (const oldestSessionId of evicted) {
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
      this.relaySessions.set(derived.session.sessionId, createRelaySessionState(derived.session));
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
      this.relaySessions.set(
        derived.session.sessionId,
        createRelaySessionState({
          ...derived.session,
          profile: derived.session.profile as RelayHandshakeProfile,
        }),
      );
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

  private recordError(code: BridgeErrorCode, message: string): void {
    this.lastErrorCode = code;
    this.lastErrorMessage = message;
    this.lastErrorAt = Date.now();
  }

  private reportStatus(code: BridgeErrorCode | 'CIRCUIT_OPEN', message: string): void {
    out.warn(`[relay] bridge-status [${code}]: ${message}`);
  }
}
