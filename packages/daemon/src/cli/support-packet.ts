export const SUPPORT_PACKET_DOCS_URL =
  'https://docs.getviewport.com/troubleshooting/support-packet';

const SUPPORT_PACKET_OMITTED_SECRETS = [
  'credentials',
  'worker_private_keys',
  'pairing_codes',
  'bootstrap_tokens',
  'claim_tokens',
  'lease_tokens',
  'provider_tokens',
  'model_keys',
];

export function supportPacketMetadata(): {
  docsUrl: string;
  reviewBeforeSharing: true;
  omittedSecrets: string[];
} {
  return {
    docsUrl: SUPPORT_PACKET_DOCS_URL,
    reviewBeforeSharing: true,
    omittedSecrets: SUPPORT_PACKET_OMITTED_SECRETS,
  };
}
