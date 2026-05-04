import type { RelayHandshakeProfile } from './bridge-key-exchange.js';

function profileStrength(profile: RelayHandshakeProfile): number {
  return profile === 'noise-ikpsk2' ? 2 : 1;
}

export function isCompatibleProfile(
  required: RelayHandshakeProfile,
  requested: RelayHandshakeProfile,
): boolean {
  return profileStrength(requested) >= profileStrength(required);
}
