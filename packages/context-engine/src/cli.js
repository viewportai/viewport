#!/usr/bin/env node
const path = require('node:path');
const { ContextVault } = require('./index');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      args._.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireArg(args, name) {
  if (!args[name]) {
    throw new Error(`Missing --${name}`);
  }
  return args[name];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [resource, action] = args._;
  const home = path.resolve(args.home || process.env.VAULT_HOME || '.vault-home');
  const vault = new ContextVault(home);

  if (resource === 'identity' && action === 'create') {
    print(vault.createIdentity(requireArg(args, 'name')));
    return;
  }

  if (resource === 'identity' && action === 'export-public') {
    print(vault.exportPublicIdentity(requireArg(args, 'name')));
    return;
  }

  if (resource === 'identity' && action === 'import-public') {
    vault.importPublicIdentity(JSON.parse(requireArg(args, 'json')));
    print({ ok: true });
    return;
  }

  if (resource === 'repo' && action === 'create') {
    print(vault.createRepo(requireArg(args, 'repo'), requireArg(args, 'owner')));
    return;
  }

  if (resource === 'repo' && action === 'grant') {
    print(vault.grantRepo({
      repoId: requireArg(args, 'repo'),
      actorName: requireArg(args, 'actor'),
      recipientName: requireArg(args, 'to'),
    }));
    return;
  }

  if (resource === 'repo' && action === 'revoke') {
    print(vault.revokeRepo({
      repoId: requireArg(args, 'repo'),
      actorName: requireArg(args, 'actor'),
      recipientName: requireArg(args, 'from'),
    }));
    return;
  }

  if (resource === 'entry' && action === 'add') {
    print(vault.addEntry({
      repoId: requireArg(args, 'repo'),
      actorName: requireArg(args, 'actor'),
      scope: args.scope || 'project',
      title: requireArg(args, 'title'),
      body: requireArg(args, 'body'),
      source: args.source,
      sourceKind: args['source-kind'],
      trustState: args.trust || 'approved',
    }));
    return;
  }

  if (resource === 'entry' && action === 'propose') {
    print(vault.proposeEntry({
      repoId: requireArg(args, 'repo'),
      actorName: requireArg(args, 'actor'),
      title: requireArg(args, 'title'),
      body: requireArg(args, 'body'),
      source: args.source,
      sourceKind: args['source-kind'],
    }));
    return;
  }

  if (resource === 'entry' && action === 'approve-candidate') {
    print(vault.approveCandidate({
      repoId: requireArg(args, 'repo'),
      actorName: requireArg(args, 'actor'),
      candidateId: requireArg(args, 'candidate'),
      title: requireArg(args, 'title'),
      body: requireArg(args, 'body'),
      source: args.source,
    }));
    return;
  }

  if (resource === 'entry' && action === 'supersede') {
    print(vault.supersedeEntry({
      repoId: requireArg(args, 'repo'),
      actorName: requireArg(args, 'actor'),
      entryId: requireArg(args, 'entry'),
      title: requireArg(args, 'title'),
      body: requireArg(args, 'body'),
    }));
    return;
  }

  if (resource === 'sync' && action === 'export') {
    print(vault.exportSync({
      repoId: requireArg(args, 'repo'),
      outDir: path.resolve(requireArg(args, 'out')),
    }));
    return;
  }

  if (resource === 'sync' && action === 'import') {
    print(vault.importSync({
      repoId: requireArg(args, 'repo'),
      actorName: requireArg(args, 'actor'),
      inDir: path.resolve(requireArg(args, 'in')),
    }));
    return;
  }

  if (resource === 'search') {
    print(vault.search({
      repoId: requireArg(args, 'repo'),
      actorName: requireArg(args, 'actor'),
      query: requireArg(args, 'query'),
    }));
    return;
  }

  if (resource === 'bundle' && action === 'resolve') {
    print(vault.resolveBundle({
      repoId: requireArg(args, 'repo'),
      actorName: requireArg(args, 'actor'),
      packs: String(args.packs || '').split(',').filter(Boolean),
      target: args.target ? { ref: args.target } : {},
      includePrivate: Boolean(args['include-private']),
    }));
    return;
  }

  throw new Error(`Unknown command: ${args._.join(' ')}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
