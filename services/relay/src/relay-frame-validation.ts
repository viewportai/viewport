export type FramePayload = Record<string, unknown>;

export function parseFramePayload(text: string): FramePayload | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as FramePayload;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isE2eeEnvelope(frame: FramePayload): boolean {
  return (
    frame['type'] === 'e2ee' &&
    frame['version'] === 2 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    isNonEmptyString(frame['sessionId']) &&
    typeof frame['epoch'] === 'number' &&
    Number.isInteger(frame['epoch']) &&
    (frame['epoch'] as number) >= 1 &&
    typeof frame['seq'] === 'number' &&
    Number.isInteger(frame['seq']) &&
    (frame['seq'] as number) >= 1 &&
    isNonEmptyString(frame['iv']) &&
    isNonEmptyString(frame['tag']) &&
    isNonEmptyString(frame['ciphertext'])
  );
}

export function isClientControlFrame(frame: FramePayload): boolean {
  if (
    frame['type'] === 'relay_key_exchange_init' &&
    frame['version'] === 3 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['clientEphemeralPublicKey'] === 'string' &&
    typeof frame['encryptedClientStatic'] === 'string'
  ) {
    if (
      frame['profile'] === 'noise-ikpsk2' &&
      (typeof frame['pairingPeerId'] !== 'string' || frame['pairingPeerId'].trim().length === 0)
    ) {
      return false;
    }
    return true;
  }

  if (
    frame['type'] === 'relay_key_exchange_init' &&
    frame['version'] === 2 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['clientPublicKey'] === 'string' &&
    typeof frame['clientNonce'] === 'string' &&
    typeof frame['clientProof'] === 'string'
  ) {
    if (
      frame['profile'] === 'noise-ikpsk2' &&
      (typeof frame['pairingPeerId'] !== 'string' || frame['pairingPeerId'].trim().length === 0)
    ) {
      return false;
    }
    return true;
  }

  return false;
}

export function isDaemonControlFrame(frame: FramePayload): boolean {
  if (
    frame['type'] === 'relay_key_update_required' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['nextEpoch'] === 'number'
  ) {
    return true;
  }
  if (
    frame['type'] === 'relay_key_exchange_response' &&
    frame['version'] === 3 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['daemonPublicKey'] === 'string' &&
    typeof frame['daemonEphemeralPublicKey'] === 'string' &&
    typeof frame['encryptedMetadata'] === 'string' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['epoch'] === 'number' &&
    Number.isInteger(frame['epoch']) &&
    (frame['epoch'] as number) >= 1 &&
    typeof frame['proof'] === 'string'
  ) {
    return true;
  }

  return (
    frame['type'] === 'relay_key_exchange_response' &&
    frame['version'] === 2 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['daemonNonce'] === 'string' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['epoch'] === 'number' &&
    typeof frame['proof'] === 'string'
  );
}

export function isPairingOfferRequestFrame(frame: FramePayload): boolean {
  return (
    frame['type'] === 'relay_pairing_offer_request' &&
    typeof frame['requestId'] === 'string' &&
    frame['requestId'].trim().length > 0 &&
    typeof frame['clientChannelPublicKey'] === 'string' &&
    frame['clientChannelPublicKey'].trim().length > 0 &&
    (typeof frame['ttlSeconds'] === 'undefined' ||
      (typeof frame['ttlSeconds'] === 'number' &&
        Number.isInteger(frame['ttlSeconds']) &&
        (frame['ttlSeconds'] as number) >= 30 &&
        (frame['ttlSeconds'] as number) <= 3600))
  );
}

export function isPairingRedeemRequestFrame(frame: FramePayload): boolean {
  return (
    frame['type'] === 'relay_pairing_redeem_request' &&
    typeof frame['requestId'] === 'string' &&
    frame['requestId'].trim().length > 0 &&
    typeof frame['offerId'] === 'string' &&
    frame['offerId'].trim().length > 0 &&
    typeof frame['encIv'] === 'string' &&
    frame['encIv'].trim().length > 0 &&
    typeof frame['encTag'] === 'string' &&
    frame['encTag'].trim().length > 0 &&
    typeof frame['encCiphertext'] === 'string' &&
    frame['encCiphertext'].trim().length > 0
  );
}

export function isPairingResponseFrame(frame: FramePayload): boolean {
  const type = frame['type'];
  if (type !== 'relay_pairing_offer_response' && type !== 'relay_pairing_redeem_response') {
    return false;
  }
  if (typeof frame['requestId'] !== 'string' || frame['requestId'].trim().length === 0) {
    return false;
  }
  if (typeof frame['ok'] !== 'boolean') return false;
  if (frame['ok'] === false) {
    return typeof frame['errorCode'] === 'string' && frame['errorCode'].trim().length > 0;
  }
  if (type === 'relay_pairing_offer_response') {
    return (
      typeof frame['daemonChannelPublicKey'] === 'string' &&
      frame['daemonChannelPublicKey'].trim().length > 0 &&
      typeof frame['encIv'] === 'string' &&
      frame['encIv'].trim().length > 0 &&
      typeof frame['encTag'] === 'string' &&
      frame['encTag'].trim().length > 0 &&
      typeof frame['encCiphertext'] === 'string' &&
      frame['encCiphertext'].trim().length > 0
    );
  }
  return true;
}

export function extractPairingRequestId(frame: FramePayload): string | null {
  if (isPairingOfferRequestFrame(frame) || isPairingRedeemRequestFrame(frame)) {
    return (frame['requestId'] as string).trim();
  }
  if (isPairingResponseFrame(frame)) {
    return (frame['requestId'] as string).trim();
  }
  return null;
}

export function isPairingClientFrame(frame: FramePayload): boolean {
  return isPairingOfferRequestFrame(frame) || isPairingRedeemRequestFrame(frame);
}

export function isPairingDaemonFrame(frame: FramePayload): boolean {
  return isPairingResponseFrame(frame);
}

export function isKeyExchangeInitFrame(frame: FramePayload): boolean {
  return isClientControlFrame(frame) && frame['type'] === 'relay_key_exchange_init';
}

export function isKeyExchangeResponseFrame(frame: FramePayload): boolean {
  return isDaemonControlFrame(frame) && frame['type'] === 'relay_key_exchange_response';
}

export function isKeyUpdateRequiredFrame(frame: FramePayload): boolean {
  return isDaemonControlFrame(frame) && frame['type'] === 'relay_key_update_required';
}

export function isAllowedClientFrame(text: string): boolean {
  const frame = parseFramePayload(text);
  if (!frame) return false;
  return isE2eeEnvelope(frame) || isClientControlFrame(frame) || isPairingClientFrame(frame);
}

export function isAllowedDaemonFrame(text: string): boolean {
  const frame = parseFramePayload(text);
  if (!frame) return false;
  return isE2eeEnvelope(frame) || isDaemonControlFrame(frame) || isPairingDaemonFrame(frame);
}

export function extractFrameProfile(frame: FramePayload): 'noise-ik' | 'noise-ikpsk2' | null {
  const profile = frame['profile'];
  if (profile === 'noise-ik' || profile === 'noise-ikpsk2') return profile;
  return null;
}
