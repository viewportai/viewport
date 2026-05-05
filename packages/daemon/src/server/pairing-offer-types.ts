export interface PairingOfferConnection {
  host: string;
  port: number;
  listen: string;
  socketPath?: string;
  profile: 'local' | 'lan' | 'relay';
}

export interface PairingOfferStoreRecord {
  offerId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  redeemedAt?: number;
  failedRedeemAttempts?: number;
  lockedAt?: number;
  redeemSecretHash: string;
  trustAnchor: string;
  daemonDeviceId: string;
  daemonPublicKey: string;
  connection: PairingOfferConnection;
}

export interface PairingOfferStore {
  version: 1;
  offers: PairingOfferStoreRecord[];
}

export interface PairingOfferPublicPayload extends PairingOfferConnection {
  offerId: string;
  createdAt: number;
  expiresAt: number;
  trustAnchor: string;
  daemonDeviceId: string;
}

export interface PairingOfferIssuedPayload extends PairingOfferPublicPayload {
  redeemSecret: string;
  daemonPublicKey: string;
}

export interface PairingOfferRedeemedPayload {
  offerId: string;
  trustAnchor: string;
  daemonDeviceId: string;
  daemonPublicKey: string;
  peerId: string;
  relayPairingPeerId: string;
  serverSignature: string;
  connection: PairingOfferConnection;
  expiresAt: number;
  createdAt: number;
}

export interface PairingTrustAnchorRecord {
  version: 1;
  id: string;
  createdAt: number;
  secret: string;
}

export interface PairingTrustAnchorPublic {
  id: string;
  createdAt: number;
  fingerprint: string;
}

export interface PairingDaemonIdentityRecord {
  version: 1;
  deviceId: string;
  createdAt: number;
  publicKey: string;
  privateKey: string;
}

export interface PairingPeerBindingRecord {
  peerId: string;
  publicKey: string;
  relayPairingSecretCiphertext?: string;
  relayPairingSecretIv?: string;
  relayPairingSecretTag?: string;
  firstPairedAt: number;
  lastPairedAt: number;
  lastOfferId: string;
  trustAnchor: string;
}

export interface PairingPeerBindingStore {
  version: 1;
  peers: PairingPeerBindingRecord[];
}

export interface PairingDaemonIdentityPublic {
  deviceId: string;
  createdAt: number;
  fingerprint: string;
  publicKey: string;
}

export interface PairingClientIdentity {
  peerId: string;
  publicKey: string;
  privateKey: string;
}

export interface PairingRedeemProof {
  peerId: string;
  clientPublicKey: string;
  clientProof: string;
}
