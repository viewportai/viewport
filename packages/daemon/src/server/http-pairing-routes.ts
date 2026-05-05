import type { FastifyInstance } from 'fastify';
import { metrics } from '../core/metrics.js';
import { issuePairingOffer, redeemPairingOffer } from './pairing-offers.js';
import type { SecurityProfile } from './security.js';
import type { DaemonRuntimeInfo } from './http-route-types.js';
import {
  PairOfferBodySchema,
  PairRedeemBodySchema,
  invalidPayloadError,
} from './http-request-schemas.js';

const REDEEM_WINDOW_MS = 60_000;
const REDEEM_MAX_ATTEMPTS = 12;
const REDEEM_ATTEMPT_IP_MAP_MAX = 2_048;

interface RedeemAttemptEntry {
  attempts: number[];
  updatedAt: number;
}

export function recordRedeemAttempt(
  attemptsByIp: Map<string, RedeemAttemptEntry>,
  ip: string,
  nowMs: number,
): number {
  const staleBefore = nowMs - REDEEM_WINDOW_MS;
  const previous = attemptsByIp.get(ip);
  const freshAttempts = (previous?.attempts ?? []).filter((timestamp) => timestamp >= staleBefore);
  freshAttempts.push(nowMs);
  attemptsByIp.set(ip, {
    attempts: freshAttempts,
    updatedAt: nowMs,
  });

  if (attemptsByIp.size > REDEEM_ATTEMPT_IP_MAP_MAX) {
    for (const [candidateIp, entry] of attemptsByIp.entries()) {
      const newestAttempt = entry.attempts.at(-1);
      if (typeof newestAttempt !== 'number' || newestAttempt < staleBefore) {
        attemptsByIp.delete(candidateIp);
      }
    }
  }

  while (attemptsByIp.size > REDEEM_ATTEMPT_IP_MAP_MAX) {
    const oldest = attemptsByIp.entries().next();
    if (oldest.done) {
      break;
    }
    attemptsByIp.delete(oldest.value[0]);
  }

  return freshAttempts.length;
}

export function registerPairingRoutes(
  app: FastifyInstance,
  options?: {
    runtime?: DaemonRuntimeInfo;
    securityProfile?: SecurityProfile;
  },
): void {
  const runtime = options?.runtime;
  const securityProfile = options?.securityProfile;
  const redeemAttemptTimestamps = new Map<string, RedeemAttemptEntry>();

  app.post<{
    Body: {
      ttlSeconds?: number;
    };
  }>('/api/pair/offer', async (request, reply) => {
    const parsed = PairOfferBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      metrics.increment('pair.offer.invalid_payload');
      return reply.status(400).send({ error: invalidPayloadError(parsed.error) });
    }
    const ttlSeconds = parsed.data.ttlSeconds ?? 600;
    const host = runtime?.host ?? '127.0.0.1';
    const port = runtime?.port ?? Number(process.env['PORT'] ?? 7070);
    const listen = runtime?.listen ?? `${host}:${port}`;
    const profile = securityProfile?.profile ?? 'local';
    const issued = await issuePairingOffer({
      ttlSeconds,
      connection: {
        host,
        port,
        listen,
        socketPath: runtime?.socketPath,
        profile,
      },
    });
    metrics.increment('pair.offer.success');
    return {
      offerId: issued.offerId,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
      redeemSecret: issued.redeemSecret,
      trustAnchor: issued.trustAnchor,
      daemonDeviceId: issued.daemonDeviceId,
      daemonPublicKey: issued.daemonPublicKey,
      host: issued.host,
      port: issued.port,
      listen: issued.listen,
      socketPath: issued.socketPath,
      profile: issued.profile,
    };
  });

  app.post<{
    Body: {
      offerId?: string;
      proof?: string;
      trustAnchor?: string;
      clientPublicKey?: string;
      clientProof?: string;
    };
  }>('/api/pair/redeem', async (request, reply) => {
    const ip = request.ip ?? 'unknown';
    const attemptCount = recordRedeemAttempt(redeemAttemptTimestamps, ip, Date.now());
    if (attemptCount > REDEEM_MAX_ATTEMPTS) {
      metrics.increment('pair.redeem.rate_limited');
      return reply.status(429).send({ error: 'Too many redeem attempts. Try again later.' });
    }

    const parsedBody = PairRedeemBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      metrics.increment('pair.redeem.invalid_payload');
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }
    const { offerId, proof, trustAnchor, clientPublicKey, clientProof } = parsedBody.data;

    const redeemed = await redeemPairingOffer(
      offerId,
      proof,
      trustAnchor,
      clientPublicKey,
      clientProof,
    );
    if (!redeemed) {
      metrics.increment('pair.redeem.failed');
      return reply.status(404).send({ error: 'Offer not found or no longer valid' });
    }
    metrics.increment('pair.redeem.success');

    return {
      offerId: redeemed.offerId,
      createdAt: redeemed.createdAt,
      expiresAt: redeemed.expiresAt,
      peerId: redeemed.peerId,
      daemonDeviceId: redeemed.daemonDeviceId,
      daemonPublicKey: redeemed.daemonPublicKey,
      relayPairingPeerId: redeemed.relayPairingPeerId,
      serverSignature: redeemed.serverSignature,
      host: redeemed.connection.host,
      port: redeemed.connection.port,
      listen: redeemed.connection.listen,
      socketPath: redeemed.connection.socketPath,
      profile: redeemed.connection.profile,
    };
  });
}
