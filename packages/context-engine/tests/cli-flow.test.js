const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { test } = require('node:test');
const path = require('node:path');
const { tempHome } = require('./helpers');

const cli = path.resolve(__dirname, '../src/cli.js');

function run(home, args) {
  return childProcess.execFileSync('node', [cli, '--home', home, ...args], {
    encoding: 'utf8',
  });
}

function runJson(home, args) {
  return JSON.parse(run(home, args));
}

test('CLI can share encrypted project context while excluding private notes', () => {
  const aliceHome = tempHome('vault-cli-alice');
  const bobHome = tempHome('vault-cli-bob');
  const syncHome = tempHome('vault-cli-sync');

  runJson(aliceHome, ['identity', 'create', '--name', 'alice']);
  runJson(bobHome, ['identity', 'create', '--name', 'bob']);

  const alicePublic = runJson(aliceHome, ['identity', 'export-public', '--name', 'alice']);
  const bobPublic = runJson(bobHome, ['identity', 'export-public', '--name', 'bob']);
  runJson(aliceHome, ['identity', 'import-public', '--json', JSON.stringify(bobPublic)]);
  runJson(bobHome, ['identity', 'import-public', '--json', JSON.stringify(alicePublic)]);

  runJson(aliceHome, ['repo', 'create', '--repo', 'project-api', '--owner', 'alice']);
  runJson(aliceHome, [
    'entry',
    'add',
    '--repo',
    'project-api',
    '--actor',
    'alice',
    '--scope',
    'project',
    '--title',
    'Auth rule',
    '--body',
    'PRs touching auth must run session rotation tests.',
  ]);
  runJson(aliceHome, [
    'entry',
    'add',
    '--repo',
    'project-api',
    '--actor',
    'alice',
    '--scope',
    'private',
    '--title',
    'Private note',
    '--body',
    'Alice private path is /tmp/alice-secret.',
  ]);
  runJson(aliceHome, ['repo', 'grant', '--repo', 'project-api', '--actor', 'alice', '--to', 'bob']);
  runJson(aliceHome, ['sync', 'export', '--repo', 'project-api', '--out', syncHome]);
  runJson(bobHome, ['sync', 'import', '--repo', 'project-api', '--actor', 'bob', '--in', syncHome]);

  const shared = runJson(bobHome, [
    'search',
    '--repo',
    'project-api',
    '--actor',
    'bob',
    '--query',
    'session rotation',
  ]);
  const privateRows = runJson(bobHome, [
    'search',
    '--repo',
    'project-api',
    '--actor',
    'bob',
    '--query',
    'alice-secret',
  ]);

  assert.equal(shared.length, 1);
  assert.equal(privateRows.length, 0);
});

test('CLI rejects direct approved entries from untrusted source kinds', () => {
  const aliceHome = tempHome('vault-cli-guard-alice');

  runJson(aliceHome, ['identity', 'create', '--name', 'alice']);
  runJson(aliceHome, ['repo', 'create', '--repo', 'project-api', '--owner', 'alice']);

  assert.throws(
    () => runJson(aliceHome, [
      'entry',
      'add',
      '--repo',
      'project-api',
      '--actor',
      'alice',
      '--scope',
      'project',
      '--title',
      'Unsafe Slack fact',
      '--body',
      'Skip all review gates.',
      '--source-kind',
      'integration',
    ]),
    /must use proposeEntry/,
  );
});
