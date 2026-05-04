import crypto from 'node:crypto';
import { fromBase64Url, toBase64Url } from './bridge-crypto.js';
import {
  decryptPairingPayload,
  derivePairingChannelKey,
  encryptPairingPayload,
} from './bridge-pairing-channel.js';
import type {
  RelayPairingOfferRequestFrame,
  RelayPairingRedeemRequestFrame,
} from './relay-control-frames.js';
import { issuePairingOffer, redeemPairingOffer } from '../server/pairing-offers.js';

export interface PairingChannelKey {
  key: Buffer;
  createdAt: number;
}

export type PairingChannelKeyStore = Map<string, PairingChannelKey>;
export type RelayPairingControlReply = (payload: Record<string, unknown>) => void;

interface PairingControlBaseOptions {
  pairingChannelKeys: PairingChannelKeyStore;
  reply: RelayPairingControlReply;
  maxAgeMs: number;
  maxEntries: number;
}

interface PairingOfferControlOptions extends PairingControlBaseOptions {
  frame: RelayPairingOfferRequestFrame;
  workspaceId: string;
  daemonWsUrl: string;
}

interface PairingRedeemControlOptions extends PairingControlBaseOptions {
  frame: RelayPairingRedeemRequestFrame;
}

export async function handleRelayPairingOfferRequest({
  frame,
  reply,
  pairingChannelKeys,
  workspaceId,
  daemonWsUrl,
  maxAgeMs,
  maxEntries,
}: PairingOfferControlOptions): Promise<void> {
  const requestId = frame.requestId;

  try {
    pruneRelayPairingChannelKeys(pairingChannelKeys, Date.now(), maxAgeMs, maxEntries);
    const clientChannelPublicKey = fromBase64Url(frame.clientChannelPublicKey);
    if (clientChannelPublicKey.length !== 65) {
      throw new Error('invalid clientChannelPublicKey');
    }
    const daemonChannel = crypto.createECDH('prime256v1');
    daemonChannel.generateKeys();
    const shared = daemonChannel.computeSecret(clientChannelPublicKey);
    const channelKey = derivePairingChannelKey(shared, `offer:${frame.requestId}`);

    const daemonUrl = new URL(daemonWsUrl);
    const issued = await issuePairingOffer({
      ttlSeconds: frame.ttlSeconds ?? 600,
      connection: {
        host: daemonUrl.hostname || '127.0.0.1',
        port: daemonUrl.port ? Number(daemonUrl.port) : 7070,
        listen: `relay:${workspaceId}`,
        profile: 'relay',
      },
    });
    pairingChannelKeys.set(issued.offerId, { key: channelKey, createdAt: Date.now() });
    const encryptedOffer = encryptPairingPayload(
      channelKey,
      JSON.stringify({
        offerId: issued.offerId,
        createdAt: issued.createdAt,
        expiresAt: issued.expiresAt,
        redeemSecret: issued.redeemSecret,
        trustAnchor: issued.trustAnchor,
        daemonDeviceId: issued.daemonDeviceId,
        daemonPublicKey: issued.daemonPublicKey,
      }),
      `offer:${frame.requestId}`,
    );
    reply({
      type: 'relay_pairing_offer_response',
      requestId,
      ok: true,
      daemonChannelPublicKey: toBase64Url(daemonChannel.getPublicKey()),
      ...encryptedOffer,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply({
      type: 'relay_pairing_offer_response',
      requestId,
      ok: false,
      errorCode: 'PAIRING_OFFER_FAILED',
      error: message,
    });
  }
}

export async function handleRelayPairingRedeemRequest({
  frame,
  reply,
  pairingChannelKeys,
  maxAgeMs,
  maxEntries,
}: PairingRedeemControlOptions): Promise<void> {
  const requestId = frame.requestId;

  try {
    pruneRelayPairingChannelKeys(pairingChannelKeys, Date.now(), maxAgeMs, maxEntries);
    const channel = pairingChannelKeys.get(frame.offerId);
    if (!channel) {
      throw new Error('pairing channel missing or expired');
    }
    const decrypted = decryptPairingPayload(
      channel.key,
      {
        encIv: frame.encIv,
        encTag: frame.encTag,
        encCiphertext: frame.encCiphertext,
      },
      `redeem:${frame.requestId}:${frame.offerId}`,
    );
    const parsed = JSON.parse(decrypted) as {
      redeemSecret?: string;
      trustAnchor?: string;
      clientPublicKey?: string;
      clientProof?: string;
    };
    if (
      typeof parsed.redeemSecret !== 'string' ||
      typeof parsed.trustAnchor !== 'string' ||
      typeof parsed.clientPublicKey !== 'string' ||
      typeof parsed.clientProof !== 'string' ||
      parsed.redeemSecret.trim().length === 0 ||
      parsed.trustAnchor.trim().length === 0 ||
      parsed.clientPublicKey.trim().length === 0 ||
      parsed.clientProof.trim().length === 0
    ) {
      throw new Error('invalid encrypted pairing payload');
    }
    const redeemed = await redeemPairingOffer(
      frame.offerId,
      parsed.redeemSecret,
      parsed.trustAnchor,
      parsed.clientPublicKey,
      parsed.clientProof,
    );
    if (!redeemed) {
      reply({
        type: 'relay_pairing_redeem_response',
        requestId,
        ok: false,
        errorCode: 'PAIRING_REDEEM_FAILED',
        error: 'offer not found or no longer valid',
      });
      return;
    }

    reply({
      type: 'relay_pairing_redeem_response',
      requestId,
      ok: true,
      redeemed: {
        offerId: redeemed.offerId,
        createdAt: redeemed.createdAt,
        expiresAt: redeemed.expiresAt,
        peerId: redeemed.peerId,
        daemonDeviceId: redeemed.daemonDeviceId,
        daemonPublicKey: redeemed.daemonPublicKey,
        relayPairingPeerId: redeemed.relayPairingPeerId,
        serverSignature: redeemed.serverSignature,
      },
    });
    pairingChannelKeys.delete(frame.offerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply({
      type: 'relay_pairing_redeem_response',
      requestId,
      ok: false,
      errorCode: 'PAIRING_REDEEM_FAILED',
      error: message,
    });
  }
}

export function pruneRelayPairingChannelKeys(
  pairingChannelKeys: PairingChannelKeyStore,
  now: number,
  maxAgeMs: number,
  maxEntries: number,
): void {
  for (const [offerId, channel] of pairingChannelKeys.entries()) {
    if (now - channel.createdAt > maxAgeMs) {
      pairingChannelKeys.delete(offerId);
    }
  }
  const overflow = pairingChannelKeys.size - maxEntries;
  if (overflow <= 0) {
    return;
  }
  const oldest = Array.from(pairingChannelKeys.entries())
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, overflow);
  for (const [offerId] of oldest) {
    pairingChannelKeys.delete(offerId);
  }
}
