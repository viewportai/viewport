import { Sandbox } from 'e2b';

const template = process.env['E2B_TEMPLATE'] ?? 'viewport-vpd-02511-dev';

if (!process.env['E2B_API_KEY']) {
  console.error('E2B_API_KEY is required');
  process.exit(1);
}

const sandbox = await Sandbox.create(template, {
  envs: {
    VIEWPORT_E2B_VPD_TEMPLATE_PROOF: '1',
  },
  timeoutMs: 600_000,
});

try {
  const help = await sandbox.commands.run('vpd --help | head -12', { timeoutMs: 60_000 });
  const node = await sandbox.commands.run('node --version && npm --version', { timeoutMs: 60_000 });

  console.log(
    JSON.stringify(
      {
        ok: help.exitCode === 0,
        template,
        sandboxId: sandbox.sandboxId,
        help: help.stdout.trim(),
        runtime: node.stdout.trim(),
      },
      null,
      2,
    ),
  );
} finally {
  await sandbox.kill();
}
