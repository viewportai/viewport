import { Sandbox } from 'e2b';

if (!process.env['E2B_API_KEY']) {
  console.error('E2B_API_KEY is required');
  process.exit(1);
}

const sandbox = await Sandbox.create({
  envs: {
    VIEWPORT_E2B_ROUNDTRIP: '1',
  },
});

try {
  const hello = await sandbox.commands.run('echo "viewport-managed-runner:$VIEWPORT_E2B_ROUNDTRIP"');
  await sandbox.commands.run('mkdir -p /tmp/viewport && printf "m2-roundtrip" > /tmp/viewport/proof.txt');
  const file = await sandbox.commands.run('cat /tmp/viewport/proof.txt');

  console.log(
    JSON.stringify(
      {
        ok: true,
        sandboxId: sandbox.sandboxId,
        hello: hello.stdout.trim(),
        file: file.stdout.trim(),
      },
      null,
      2,
    ),
  );
} finally {
  await sandbox.kill();
}
