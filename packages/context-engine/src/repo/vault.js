const crypto = require('node:crypto');
const {
  createRepoKey,
} = require('../crypto/keys');
const { ResolverPinMismatchError, buildContextBundle } = require('./bundles');
const candidates = require('./candidates');
const devices = require('./devices');
const events = require('./events');
const identities = require('./identities');
const { ensureDir, readJson, writeJson } = require('./files');
const { materializeRepo, materializeRepoAsync } = require('./materializer');
const membership = require('./membership');
const { repoPaths, vaultPaths } = require('./paths');
const profiles = require('./profiles');
const receipts = require('./receipts');
const sync = require('./sync');
const users = require('./users');
const { openStore, resetStore } = require('../store/sqlite');
const { allCandidates, allEntries, searchEntries } = require('../store/search');

const SHARED_SCOPES = new Set(['resource', 'team', 'organization', 'project']);
const DIRECT_APPROVAL_SOURCE_KINDS = new Set(['human']);

class ContextVault {
  constructor(home, { keyStore = null } = {}) {
    this.home = home;
    this.keyStore = keyStore;
    const paths = vaultPaths(home);
    ensureDir(paths.identitiesDir);
    ensureDir(paths.reposDir);
  }

  createIdentity(name) {
    return identities.createIdentity(this.home, name, { keyStore: this.keyStore });
  }

  createUser(options) {
    return users.createUser(this.home, options);
  }

  recoverUserIdentity(options) {
    return users.recoverUserIdentity(this.home, options);
  }

  rotateUserDecryptionIdentity(options) {
    return users.rotateUserDecryptionIdentity(this.home, options);
  }

  createDeviceApprovalRequest(options) {
    return devices.createDeviceApprovalRequest(this.home, {
      ...options,
      keyStore: this.keyStore,
    });
  }

  approveDeviceRequest(options) {
    return devices.approveDeviceRequest(this.home, options);
  }

  acceptDeviceApproval(options) {
    return devices.acceptDeviceApproval(this.home, {
      ...options,
      keyStore: this.keyStore,
    });
  }

  getIdentity(name) {
    return identities.getIdentity(this.home, name, { keyStore: this.keyStore });
  }

  getKnownIdentity(name) {
    return identities.getKnownIdentity(this.home, name);
  }

  exportPublicIdentity(name) {
    return identities.exportPublicIdentity(this.home, name);
  }

  importPublicIdentity(identity) {
    identities.importPublicIdentity(this.home, identity);
  }

  identityPath(name) {
    return identities.identityPath(this.home, name);
  }

  createRepo(repoId, ownerName, { actorName = ownerName } = {}) {
    const owner = this.getKnownIdentity(ownerName);
    const paths = repoPaths(this.home, repoId);
    ensureDir(paths.eventsDir);
    ensureDir(paths.eraseReceiptsDir);
    ensureDir(paths.profilesDir);
    const repoKey = createRepoKey();

    writeJson(paths.metadata, {
      repoId,
      createdAt: new Date().toISOString(),
      currentKeyEpoch: 1,
      ownerName,
      erasedActors: {},
    });

    writeJson(paths.keys, {
      epochs: {
        1: repoKey.toString('base64'),
      },
    });

    this.appendGrantEvent({
      repoId,
      actorName,
      recipient: owner,
      keyEpoch: 1,
      repoKey,
      eventType: 'repo.created',
    });

    return readJson(paths.metadata);
  }

  async createRepoHpke(repoId, ownerName, { actorName = ownerName } = {}) {
    const owner = this.getKnownIdentity(ownerName);
    const paths = repoPaths(this.home, repoId);
    ensureDir(paths.eventsDir);
    ensureDir(paths.eraseReceiptsDir);
    ensureDir(paths.profilesDir);
    const repoKey = createRepoKey();

    writeJson(paths.metadata, {
      repoId,
      createdAt: new Date().toISOString(),
      currentKeyEpoch: 1,
      ownerName,
      erasedActors: {},
      grantProtocol: 'hpke-draft-01',
    });

    writeJson(paths.keys, {
      epochs: {
        1: repoKey.toString('base64'),
      },
    });

    await this.appendGrantEventHpke({
      repoId,
      actorName,
      recipient: owner,
      keyEpoch: 1,
      repoKey,
      eventType: 'repo.created',
    });

    return readJson(paths.metadata);
  }

  addEntry(options) {
    const {
      repoId,
      actorName,
      scope = 'resource',
      title,
      body,
      source = 'manual://local',
      sourceKind = 'human',
      trustState = 'approved',
      appliesTo = [],
      review = null,
      contextResourceId = null,
    } = options;

    if (trustState !== 'approved' && trustState !== 'canonical') {
      throw new Error(`Direct entries must be approved or canonical, got ${trustState}`);
    }

    if (!DIRECT_APPROVAL_SOURCE_KINDS.has(sourceKind)) {
      throw new Error(`Untrusted source kind ${sourceKind} must use proposeEntry and human review`);
    }

    const now = new Date().toISOString();
    const payload = {
      id: options.id ?? `ctxe_${crypto.randomUUID()}`,
      versionId: `ctxev_${crypto.randomUUID()}`,
      scope,
      title,
      body,
      source,
      sourceKind,
      trustState,
      appliesTo,
      review,
      createdAt: now,
    };

    if (scope === 'private') {
      return this.appendPrivateEvent({
        repoId,
        actorName,
        type: 'entry.approved',
        payload,
        contextResourceId,
      });
    }

    if (!SHARED_SCOPES.has(scope)) {
      throw new Error(`Unsupported scope: ${scope}`);
    }

    return this.appendSharedEvent({
      repoId,
      actorName,
      type: 'entry.approved',
      payload,
      contextResourceId,
    });
  }

  proposeEntry(options) {
    return candidates.proposeEntry(this, options);
  }

  approveCandidate({ repoId, actorName, candidateId, title, body, source, review, contextResourceId }) {
    return candidates.approveCandidate(this, { repoId, actorName, candidateId, title, body, source, review, contextResourceId });
  }

  assignCandidate({ repoId, actorName, candidateId, reviewerName }) {
    return candidates.assignCandidate(this, { repoId, actorName, candidateId, reviewerName });
  }

  rejectCandidate({ repoId, actorName, candidateId, reason }) {
    return candidates.rejectCandidate(this, { repoId, actorName, candidateId, reason });
  }

  tombstoneCandidate({ repoId, actorName, candidateId, reason }) {
    return candidates.tombstoneCandidate(this, { repoId, actorName, candidateId, reason });
  }

  batchAssignCandidates({ repoId, actorName, candidateIds, reviewerName }) {
    return candidates.batchAssignCandidates(this, { repoId, actorName, candidateIds, reviewerName });
  }

  batchRejectCandidates({ repoId, actorName, candidateIds, reason }) {
    return candidates.batchRejectCandidates(this, { repoId, actorName, candidateIds, reason });
  }

  batchTombstoneCandidates({ repoId, actorName, candidateIds, reason }) {
    return candidates.batchTombstoneCandidates(this, { repoId, actorName, candidateIds, reason });
  }

  decayCandidates({ repoId, actorName, staleAfterDays = 14, now = new Date() }) {
    return candidates.decayCandidates(this, { repoId, actorName, staleAfterDays, now });
  }

  supersedeEntry({ repoId, actorName, entryId, title, body }) {
    const replacementId = `ctxe_${crypto.randomUUID()}`;
    const supersede = this.appendSharedEvent({
      repoId,
      actorName,
      type: 'entry.superseded',
      payload: {
        id: entryId,
        supersededBy: replacementId,
        createdAt: new Date().toISOString(),
      },
    });

    const replacement = this.addEntry({
      repoId,
      actorName,
      id: replacementId,
      scope: 'resource',
      title,
      body,
      source: `supersedes://${entryId}`,
      sourceKind: 'human',
      trustState: 'approved',
    });

    return { supersede, replacement };
  }

  grantRepo({ repoId, actorName, recipientName }) {
    return membership.grantRepo(this, { repoId, actorName, recipientName });
  }

  grantRepoHpke({ repoId, actorName, recipientName }) {
    return membership.grantRepoHpke(this, { repoId, actorName, recipientName });
  }

  revokeRepo({ repoId, actorName, recipientName }) {
    return membership.revokeRepo(this, { repoId, actorName, recipientName });
  }

  revokeRepoHpke({ repoId, actorName, recipientName }) {
    return membership.revokeRepoHpke(this, { repoId, actorName, recipientName });
  }

  exportSync({ repoId, outDir }) {
    return sync.exportSync(this.home, { repoId, outDir });
  }

  listSyncEvents({ repoId }) {
    return sync.listSyncEvents(this.home, { repoId });
  }

  importSync({ repoId, inDir, actorName }) {
    return sync.importSync(this, { repoId, inDir, actorName });
  }

  importSyncHpke({ repoId, inDir, actorName }) {
    return sync.importSyncAsync(this, { repoId, inDir, actorName });
  }

  importSyncEvents({ repoId, events, actorName }) {
    return sync.importSyncEvents(this, { repoId, events, actorName });
  }

  writeProfile({ repoId, name, profile }) {
    return profiles.writeProfile(this.home, { repoId, name, profile });
  }

  getProfile({ repoId, name }) {
    return profiles.getProfile(this.home, { repoId, name });
  }

  materialize({ repoId, actorName }) {
    const paths = repoPaths(this.home, repoId);
    ensureDir(paths.root);
    const metadata = readJson(paths.metadata, { repoId, erasedActors: {} });
    if (metadata.erasedActors?.[actorName]) {
      resetStore(paths.db).close();
      return { entries: [], candidates: [] };
    }

    return materializeRepo({
      paths,
      actorName,
      identity: this.getIdentity(actorName),
      publicKeys: this.loadPublicKeys(),
    });
  }

  async materializeHpke({ repoId, actorName }) {
    const paths = repoPaths(this.home, repoId);
    ensureDir(paths.root);
    const metadata = readJson(paths.metadata, { repoId, erasedActors: {} });
    if (metadata.erasedActors?.[actorName]) {
      resetStore(paths.db).close();
      return { entries: [], candidates: [] };
    }

    return materializeRepoAsync({
      paths,
      actorName,
      identity: this.getIdentity(actorName),
      publicKeys: this.loadPublicKeys(),
    });
  }

  resolveBundle({
    repoId,
    actorName,
    packs = [],
    target = {},
    includePrivate = false,
    pins = {},
    override = null,
    query = null,
    maxItems = null,
    offline = false,
    lastSyncAt = null,
    profile = null,
    profilePin = null,
  }) {
    const profileDescriptor = profile
      ? profiles.getProfile(this.home, { repoId, name: profile, expected: profilePin })
      : null;
    const effectivePacks = packs.length > 0 ? packs : (profileDescriptor?.profile.packs ?? []);
    const effectiveQuery = query ?? profileDescriptor?.profile.query ?? null;
    const effectiveMaxItems = maxItems ?? profileDescriptor?.profile.maxItems ?? null;

    this.materialize({ repoId, actorName });
    const paths = repoPaths(this.home, repoId);
    const db = openStore(paths.db);
    const rows = allEntries(db).filter((entry) => {
      if (entry.superseded_by) {
        return false;
      }

      if (entry.scope === 'private') {
        return includePrivate;
      }

      return ['approved', 'canonical'].includes(entry.trust_state);
    });
    const bundle = buildContextBundle({
      actorName,
      rows,
      packs: effectivePacks,
      target,
      includePrivate,
      pins,
      override,
      query: effectiveQuery,
      maxItems: effectiveMaxItems,
      offline,
      lastSyncAt,
      profileDescriptor: profileDescriptor ? {
        name: profileDescriptor.name,
        path: profileDescriptor.path,
        digest: profileDescriptor.digest,
        schemaVersion: profileDescriptor.schemaVersion,
      } : null,
    });

    db.prepare(`
      INSERT OR REPLACE INTO context_bundles (id, digest, manifest_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      bundle.manifest.bundle_id,
      bundle.manifest.digest,
      JSON.stringify(bundle.manifest),
      bundle.manifest.resolved_at,
    );
    db.close();

    return bundle;
  }

  search({ repoId, actorName, query }) {
    this.materialize({ repoId, actorName });
    const db = openStore(repoPaths(this.home, repoId).db);
    const rows = searchEntries(db, query);
    db.close();
    return rows;
  }

  allEntries({ repoId }) {
    const db = openStore(repoPaths(this.home, repoId).db);
    const rows = allEntries(db);
    db.close();
    return rows;
  }

  allCandidates({ repoId, actorName }) {
    if (actorName) {
      this.materialize({ repoId, actorName });
    }

    const db = openStore(repoPaths(this.home, repoId).db);
    const rows = allCandidates(db);
    db.close();
    return rows;
  }

  rebuild({ repoId, actorName }) {
    return this.materialize({ repoId, actorName });
  }

  cooperativeErase({ repoId, actorName, revocationEventId }) {
    return receipts.cooperativeErase(this, { repoId, actorName, revocationEventId });
  }

  verifyEraseReceipt({ repoId, receipt }) {
    return receipts.verifyEraseReceipt(this, { repoId, receipt });
  }

  getRepoMetadata(repoId) {
    const metadata = readJson(repoPaths(this.home, repoId).metadata);
    if (!metadata) {
      throw new Error(`Unknown repo: ${repoId}`);
    }
    return metadata;
  }

  getRepoKey(repoId, keyEpoch) {
    const keys = readJson(repoPaths(this.home, repoId).keys, { epochs: {} });
    const encoded = keys.epochs[String(keyEpoch)];
    if (!encoded) {
      throw new Error(`Missing repo key for ${repoId} epoch ${keyEpoch}`);
    }
    return Buffer.from(encoded, 'base64');
  }

  appendSharedEvent({ repoId, actorName, type, payload, contextResourceId = null }) {
    return events.appendSharedEvent(this, { repoId, actorName, type, payload, contextResourceId });
  }

  appendPrivateEvent({ repoId, actorName, type, payload, contextResourceId = null }) {
    return events.appendPrivateEvent(this, { repoId, actorName, type, payload, contextResourceId });
  }

  appendGrantEvent({ repoId, actorName, recipient, keyEpoch, repoKey, eventType }) {
    return membership.appendGrantEvent(this, { repoId, actorName, recipient, keyEpoch, repoKey, eventType });
  }

  appendGrantEventHpke({ repoId, actorName, recipient, keyEpoch, repoKey, eventType }) {
    return membership.appendGrantEventHpke(this, { repoId, actorName, recipient, keyEpoch, repoKey, eventType });
  }

  appendUnsignedEvent({ repoId, actor, type, keyEpoch, visibility, encrypted = null, grant = null, payloadDigest = null, contextResourceId = null }) {
    return events.appendUnsignedEvent(this, {
      repoId,
      actor,
      type,
      keyEpoch,
      visibility,
      encrypted,
      grant,
      payloadDigest,
      contextResourceId,
    });
  }

  latestEventIds(repoId) {
    return events.latestEventIds(this.home, repoId);
  }

  activeRecipients(repoId) {
    return membership.activeRecipients(this.home, repoId);
  }

  loadPublicKeys() {
    return identities.loadPublicKeys(this.home);
  }
}

module.exports = { ContextVault, ResolverPinMismatchError };
