export interface RelayStatusFrame {
  type: 'relay_status';
  code?: string;
  message?: string;
  relayWsBaseUrl?: string;
}

export interface RelayKeyUpdateRequiredFrame {
  type: 'relay_key_update_required';
  sessionId: string;
  nextEpoch: number;
  reason: 'message_threshold';
}

export interface RelayPairingOfferRequestFrame {
  type: 'relay_pairing_offer_request';
  requestId: string;
  ttlSeconds?: number;
  clientChannelPublicKey: string;
}

export interface RelayPairingRedeemRequestFrame {
  type: 'relay_pairing_redeem_request';
  requestId: string;
  offerId: string;
  encIv: string;
  encTag: string;
  encCiphertext: string;
}

export type RelayControlFrame = RelayStatusFrame | RelayKeyUpdateRequiredFrame;

export function isRelayControlFrame(value: unknown): value is RelayControlFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  if (frame['type'] === 'relay_status') return true;
  return (
    frame['type'] === 'relay_key_update_required' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['nextEpoch'] === 'number'
  );
}

export function parsePairingOfferRequestFrame(
  value: unknown,
): RelayPairingOfferRequestFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame['type'] !== 'relay_pairing_offer_request') return null;
  if (typeof frame['requestId'] !== 'string' || frame['requestId'].trim().length === 0) {
    return null;
  }
  const ttlSeconds = frame['ttlSeconds'];
  if (
    typeof ttlSeconds !== 'undefined' &&
    (!Number.isInteger(ttlSeconds) || (ttlSeconds as number) < 30 || (ttlSeconds as number) > 3600)
  ) {
    return null;
  }
  if (
    typeof frame['clientChannelPublicKey'] !== 'string' ||
    frame['clientChannelPublicKey'].trim().length === 0
  ) {
    return null;
  }
  return {
    type: 'relay_pairing_offer_request',
    requestId: frame['requestId'],
    ttlSeconds: typeof ttlSeconds === 'number' ? ttlSeconds : undefined,
    clientChannelPublicKey: frame['clientChannelPublicKey'],
  };
}

export function parsePairingRedeemRequestFrame(
  value: unknown,
): RelayPairingRedeemRequestFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame['type'] !== 'relay_pairing_redeem_request') return null;
  if (
    typeof frame['requestId'] !== 'string' ||
    typeof frame['offerId'] !== 'string' ||
    typeof frame['encIv'] !== 'string' ||
    typeof frame['encTag'] !== 'string' ||
    typeof frame['encCiphertext'] !== 'string'
  ) {
    return null;
  }
  if (
    frame['requestId'].trim().length === 0 ||
    frame['offerId'].trim().length === 0 ||
    frame['encIv'].trim().length === 0 ||
    frame['encTag'].trim().length === 0 ||
    frame['encCiphertext'].trim().length === 0
  ) {
    return null;
  }
  return {
    type: 'relay_pairing_redeem_request',
    requestId: frame['requestId'],
    offerId: frame['offerId'],
    encIv: frame['encIv'],
    encTag: frame['encTag'],
    encCiphertext: frame['encCiphertext'],
  };
}
