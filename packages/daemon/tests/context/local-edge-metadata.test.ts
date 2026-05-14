import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readContextMetadata } from '../../src/context/local-edge-metadata.js';

describe('local edge context metadata', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-metadata-'));
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('explains missing repo binding instead of leaking the canonical metadata path', async () => {
    await expect(readContextMetadata('ctx_platform_guardrails', tempHome)).rejects.toThrow(
      'Context vault ctx_platform_guardrails is not bound on this trusted edge. Run `vpd context use ctx_platform_guardrails` in the repo, then retry.',
    );
  });
});
