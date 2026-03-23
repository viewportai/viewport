#!/usr/bin/env node

// Trust Herd's local CA certificate for .test domains.
// NODE_EXTRA_CA_CERTS must be set BEFORE the Node.js process starts
// for native fetch() to trust custom CAs. If we detect Herd CA and
// the env var isn't set, re-exec with it set.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

if (!process.env['NODE_EXTRA_CA_CERTS']) {
  const herdCaPath = join(
    homedir(),
    'Library', 'Application Support', 'Herd', 'config', 'valet', 'CA',
    'LaravelValetCASelfSigned.pem',
  );
  if (existsSync(herdCaPath)) {
    // Re-exec with the CA cert set — this is the only way to make
    // Node 22's native fetch() trust custom CAs
    try {
      execFileSync(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, NODE_EXTRA_CA_CERTS: herdCaPath },
      });
    } catch (e) {
      process.exit(e.status ?? 1);
    }
    process.exit(0);
  }
}

import('../dist/index.js');
