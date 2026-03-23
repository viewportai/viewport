/**
 * Ensures Node.js trusts the Herd local CA certificate for .test domains.
 *
 * Must be called before any TLS connections are made in the process.
 * Sets NODE_EXTRA_CA_CERTS so that native fetch() trusts Herd-signed certs.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function ensureLocalTlsTrust(): void {
  // Already configured by user or a previous call
  if (process.env['NODE_EXTRA_CA_CERTS']) return;

  const herdCaPath = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Herd',
    'config',
    'valet',
    'CA',
    'LaravelValetCASelfSigned.pem',
  );

  if (existsSync(herdCaPath)) {
    process.env['NODE_EXTRA_CA_CERTS'] = herdCaPath;
  }
}
