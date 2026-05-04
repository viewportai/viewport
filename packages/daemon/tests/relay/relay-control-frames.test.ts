import { describe, expect, it } from 'vitest';
import {
  isRelayControlFrame,
  parsePairingOfferRequestFrame,
  parsePairingRedeemRequestFrame,
} from '../../src/relay/relay-control-frames.js';

describe('relay control frames', () => {
  it('accepts relay status and key update control frames', () => {
    expect(isRelayControlFrame({ type: 'relay_status', code: 'ok' })).toBe(true);
    expect(
      isRelayControlFrame({
        type: 'relay_key_update_required',
        sessionId: 'session-1',
        nextEpoch: 2,
        reason: 'message_threshold',
      }),
    ).toBe(true);
  });

  it('rejects malformed key update frames', () => {
    expect(
      isRelayControlFrame({
        type: 'relay_key_update_required',
        sessionId: 'session-1',
        nextEpoch: '2',
        reason: 'message_threshold',
      }),
    ).toBe(false);
  });

  it('parses pairing offer requests with bounded ttl', () => {
    expect(
      parsePairingOfferRequestFrame({
        type: 'relay_pairing_offer_request',
        requestId: 'request-1',
        ttlSeconds: 60,
        clientChannelPublicKey: 'client-key',
      }),
    ).toEqual({
      type: 'relay_pairing_offer_request',
      requestId: 'request-1',
      ttlSeconds: 60,
      clientChannelPublicKey: 'client-key',
    });

    expect(
      parsePairingOfferRequestFrame({
        type: 'relay_pairing_offer_request',
        requestId: 'request-1',
        ttlSeconds: 3,
        clientChannelPublicKey: 'client-key',
      }),
    ).toBeNull();
  });

  it('parses pairing redeem requests only when encrypted fields are present', () => {
    expect(
      parsePairingRedeemRequestFrame({
        type: 'relay_pairing_redeem_request',
        requestId: 'request-1',
        offerId: 'offer-1',
        encIv: 'iv',
        encTag: 'tag',
        encCiphertext: 'ciphertext',
      }),
    ).toEqual({
      type: 'relay_pairing_redeem_request',
      requestId: 'request-1',
      offerId: 'offer-1',
      encIv: 'iv',
      encTag: 'tag',
      encCiphertext: 'ciphertext',
    });

    expect(
      parsePairingRedeemRequestFrame({
        type: 'relay_pairing_redeem_request',
        requestId: 'request-1',
        offerId: 'offer-1',
        encIv: '',
        encTag: 'tag',
        encCiphertext: 'ciphertext',
      }),
    ).toBeNull();
  });
});
