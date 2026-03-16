import crypto from 'node:crypto';

export interface BusSignatureFields {
  workspaceId: string;
  sourceRelayId: string;
  targetRelayId: string | null;
  direction: 'client_to_daemon' | 'daemon_to_clients';
  payload: string;
  issuedAtMs: number;
}

export function busSignatureBase(fields: BusSignatureFields): string {
  return [
    fields.workspaceId,
    fields.sourceRelayId,
    fields.targetRelayId ?? '',
    fields.direction,
    String(fields.issuedAtMs),
    fields.payload,
  ].join('\n');
}

export function signBusFrame(fields: BusSignatureFields, key: Buffer): string {
  return crypto
    .createHmac('sha256', key)
    .update(busSignatureBase(fields), 'utf8')
    .digest('base64url');
}

export function verifyBusFrameSignature(
  fields: BusSignatureFields,
  key: Buffer,
  signature: string,
): boolean {
  const expected = signBusFrame(fields, key);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(signature, 'utf8');
  const compareLength = Math.max(expectedBuffer.length, providedBuffer.length, 1);
  const paddedExpected = Buffer.alloc(compareLength);
  const paddedProvided = Buffer.alloc(compareLength);
  expectedBuffer.copy(paddedExpected);
  providedBuffer.copy(paddedProvided);
  const equal = crypto.timingSafeEqual(paddedExpected, paddedProvided);
  return equal && expectedBuffer.length === providedBuffer.length;
}
