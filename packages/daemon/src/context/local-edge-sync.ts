import { configDir } from '../core/config.js';
import { transportFetch, type TlsVerifyMode } from '../cli/network.js';
import {
  assertCredentialsOrApprovedDevice,
  createVault,
  ensureUserOrApprovedDevice,
} from './local-edge-engine.js';
import { applyContextCandidateDecision } from './local-edge-candidates.js';
import { readCandidateDecisionApplications } from './local-edge-decision-applications.js';
import { verifyContextCandidateDecision } from './local-edge-decision-signature.js';
import { readContextMetadata, touchContextMetadata } from './local-edge-metadata.js';
import { grantContextHpkeRecipient, revokeContextUser } from './local-edge-store.js';
import { validateAndPinPublicEpoch } from '../security/epoch-public-pins.js';
import { getActiveLocalUserEpoch, listActiveLocalTeamEpochs } from '../security/epoch-store.js';
import {
  TRUSTED_EDGE_CRYPTO_PROTOCOL_HEADER,
  TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
  contextGrantMaterializationPayload,
  signContextGrantMaterialization,
  type SignedContextGrantMaterialization,
  type JsonValue,
} from '../security/epoch-protocol.js';
import type {
  ContextCandidateDecisionPullRecord,
  ContextCredentials,
  ContextSyncEvent,
  ContextSyncPullRecord,
} from './local-edge-types.js';

const CONTEXT_GRANT_EVENT_TYPES = new Set(['member.granted', 'key.rotated']);

export async function pushContextEvents(options: {
  contextResourceId: string;
  workspaceId?: string;
  serverUrl: string;
  credential: string;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{ accepted: number; pushed: number; repoId: string }> {
  const home = options.home ?? configDir();
  const metadata = await readContextMetadata(options.contextResourceId, home);
  const vault = createVault(home, metadata.keyStore);
  const events = vault.listSyncEvents({ repoId: metadata.repoId });
  const candidateDecisionApplications = await readCandidateDecisionApplications({
    home,
    contextResourceId: options.contextResourceId,
  });
  if (events.length === 0 && candidateDecisionApplications.length === 0) {
    return { accepted: 0, pushed: 0, repoId: metadata.repoId };
  }

  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    contextRuntimeUrl(options.serverUrl, options.workspaceId ?? options.contextResourceId, 'push'),
    {
      credential: options.credential,
      ...(options.workspaceId ? { target_workspace_id: options.workspaceId } : {}),
      events,
      ...(candidateDecisionApplications.length > 0
        ? { candidate_decision_applications: candidateDecisionApplications }
        : {}),
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );

  return {
    accepted: numberField(response, 'accepted'),
    pushed: events.length,
    repoId: metadata.repoId,
  };
}

export async function pullContextEvents(options: {
  contextResourceId: string;
  workspaceId?: string;
  serverUrl: string;
  credential: string;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  actorName: string;
  credentials: ContextCredentials;
  trustedDecisionKeys?: Record<string, string>;
  limit?: number;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{
  appliedCandidateDecisions: number;
  imported: number;
  materializedGrants: number;
  pendingCandidateDecisions: number;
  pulled: number;
  repoId: string;
}> {
  const home = options.home ?? configDir();
  const metadata = await readContextMetadata(options.contextResourceId, home);
  const vault = createVault(home, metadata.keyStore);
  assertCredentialsOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });
  await ensureUserOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });

  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    contextRuntimeUrl(options.serverUrl, options.workspaceId ?? options.contextResourceId, 'pull'),
    {
      credential: options.credential,
      repo_id: metadata.repoId,
      context_resource_id: options.contextResourceId,
      ...(metadata.lastServerPullReceivedAt
        ? { after_received_at: metadata.lastServerPullReceivedAt }
        : {}),
      limit: options.limit ?? 500,
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );
  const records = extractPulledRecords(response);
  const events = records.map((record) => record.signedEvent);
  const grantIdentities = await contextGrantIdentitiesForWorkspace({
    workspaceId: options.workspaceId ?? options.contextResourceId,
    home,
  });
  const imported = await vault.importSyncEvents({
    repoId: metadata.repoId,
    events,
    actorName: options.actorName,
    grantIdentities,
  });
  const materializationReceipts = contextGrantMaterializationReceipts({
    workspaceId: options.workspaceId ?? options.contextResourceId,
    contextResourceId: options.contextResourceId,
    events,
    grantIdentities,
  });
  const materializedGrants =
    materializationReceipts.length > 0
      ? await recordContextGrantMaterialization({
          workspaceId: options.workspaceId ?? options.contextResourceId,
          serverUrl: options.serverUrl,
          credential: options.credential,
          contextResourceId: options.contextResourceId,
          receipts: materializationReceipts,
          tlsVerify: options.tlsVerify,
          caCertPath: options.caCertPath,
          tlsPins: options.tlsPins,
          fetchImpl: options.fetchImpl,
        })
      : 0;
  const candidateDecisions = extractPulledCandidateDecisions(response, options.trustedDecisionKeys);
  const candidateDecisionResults = [];
  for (const decision of candidateDecisions) {
    candidateDecisionResults.push(
      await applyContextCandidateDecision({
        contextResourceId: options.contextResourceId,
        actorName: options.actorName,
        credentials: options.credentials,
        home,
        decision,
      }),
    );
  }
  const appliedCandidateDecisions = candidateDecisionResults.filter(
    (result) => result.applied,
  ).length;
  const pendingCandidateDecisions = candidateDecisionResults.filter(
    (result) => result.reason === 'candidate_not_found',
  ).length;
  await touchContextMetadata(
    {
      ...metadata,
      lastServerPullReceivedAt:
        latestReceivedAt(
          records,
          candidateDecisionResults.some((result) => result.reason === 'candidate_not_found')
            ? []
            : candidateDecisions,
        ) ?? metadata.lastServerPullReceivedAt,
    },
    home,
  );

  return {
    appliedCandidateDecisions,
    imported: imported.imported.length,
    materializedGrants,
    pendingCandidateDecisions,
    pulled: events.length,
    repoId: metadata.repoId,
  };
}

export async function recordContextGrantMaterialization(options: {
  workspaceId: string;
  serverUrl: string;
  credential: string;
  contextResourceId: string;
  receipts: SignedContextGrantMaterialization[];
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  fetchImpl?: typeof transportFetch;
}): Promise<number> {
  if (options.receipts.length === 0) {
    return 0;
  }
  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    contextGrantMaterializedUrl(options.serverUrl, options.workspaceId),
    {
      credential: options.credential,
      context_resource_id: options.contextResourceId,
      receipts: options.receipts.map((receipt) => ({
        payload: receipt.payload,
        signature: receipt.signature,
        signed_by_epoch_fingerprint: receipt.signedByEpochFingerprint,
      })),
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );

  return numberField(response, 'materialized');
}

export async function recordContextCandidatePreviewProof(options: {
  workspaceId: string;
  serverUrl: string;
  credential: string;
  contextResourceId: string;
  candidateEventId: string;
  payloadDigest?: string | null;
  previewDigest?: string | null;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  fetchImpl?: typeof transportFetch;
}): Promise<{ previewProofId: string; expiresAt: string | null }> {
  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    contextCandidatePreviewProofUrl(options.serverUrl, options.workspaceId),
    {
      credential: options.credential,
      context_resource_id: options.contextResourceId,
      candidate_event_id: options.candidateEventId,
      ...(options.payloadDigest ? { payload_digest: options.payloadDigest } : {}),
      ...(options.previewDigest ? { preview_digest: options.previewDigest } : {}),
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );

  if (!response || typeof response !== 'object') {
    throw new Error('Context preview proof response was not an object');
  }
  const previewProofId = (response as { preview_proof_id?: unknown }).preview_proof_id;
  if (typeof previewProofId !== 'string' || previewProofId === '') {
    throw new Error('Context preview proof response did not include preview_proof_id');
  }

  const expiresAt = (response as { expires_at?: unknown }).expires_at;
  return {
    previewProofId,
    expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
  };
}

export async function processPendingContextGrants(options: {
  contextResourceId: string;
  workspaceId: string;
  serverUrl: string;
  credential: string;
  actorName: string;
  credentials: ContextCredentials;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{ emitted: number; missingIdentity: number; pushed: number }> {
  const fetchImpl = options.fetchImpl ?? transportFetch;
  const response = await postJson(
    fetchImpl,
    contextPendingGrantsUrl(options.serverUrl, options.workspaceId),
    {
      credential: options.credential,
      context_resource_id: options.contextResourceId,
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );

  const grants = arrayField(response, 'grants');
  let emitted = 0;
  let missingIdentity = 0;
  let pushed = 0;

  for (const grant of grants) {
    const record = objectValue(grant);
    const userEpoch = objectField(record, 'user_epoch', false);
    if (userEpoch) {
      const userEpochId = String(numberOrStringField(userEpoch, 'id'));
      const userId = String(numberOrStringField(userEpoch, 'user_id'));
      const epoch = numberField(userEpoch, 'epoch');
      const fingerprint = stringField(userEpoch, 'fingerprint');
      const encryptionPublicKeyJwk = objectField(userEpoch, 'encryption_public_key_jwk');
      const signingPublicKeyJwk = objectField(userEpoch, 'signing_public_key_jwk');
      await validateAndPinPublicEpoch(
        {
          platformEpochId: userEpochId,
          workspaceId: options.workspaceId,
          subjectType: 'user',
          subjectId: userId,
          epoch,
          schema: 'viewport.user_crypto_epoch/v1',
          fingerprint,
          encryptionPublicKeyJwk: encryptionPublicKeyJwk as JsonValue,
          signingPublicKeyJwk: signingPublicKeyJwk as JsonValue,
          previousEpochFingerprint: nullableStringField(userEpoch, 'previous_epoch_fingerprint'),
          continuityPayload: objectField(
            userEpoch,
            'continuity_payload',
            false,
          ) as JsonValue | null,
          continuitySignature: nullableStringField(userEpoch, 'continuity_signature'),
          signedByEpochFingerprint: nullableStringField(userEpoch, 'signed_by_epoch_fingerprint'),
        },
        options.home,
      );
      const recipientName = contextUserEpochRecipientName({ userEpochId, fingerprint });
      const result = await grantContextHpkeRecipient({
        contextResourceId: options.contextResourceId,
        actorName: options.actorName,
        recipientName,
        recipientHpkePublicKey: jwkPublicXToBase64(encryptionPublicKeyJwk),
        credentials: options.credentials,
        home: options.home,
      });
      const event = objectValue(result.event);
      const grantEventId = stringField(event, 'id');
      const grantPayload = objectField(event, 'grant', false);
      const keyEpoch = grantPayload ? numberField(grantPayload, 'keyEpoch', false) : null;

      const pushResult = await pushContextEvents({
        contextResourceId: options.contextResourceId,
        workspaceId: options.workspaceId,
        serverUrl: options.serverUrl,
        credential: options.credential,
        tlsVerify: options.tlsVerify,
        caCertPath: options.caCertPath,
        tlsPins: options.tlsPins,
        home: options.home,
        fetchImpl,
      });
      pushed += pushResult.accepted;

      await postJson(
        fetchImpl,
        contextMarkGrantEmittedUrl(options.serverUrl, options.workspaceId),
        {
          credential: options.credential,
          crypto_grant_id: stringField(record, 'id'),
          grant_event_id: grantEventId,
          recipient_identity_name: recipientName,
          recipient_type: 'user_epoch',
          recipient_epoch_id: userEpochId,
          recipient_fingerprint: fingerprint,
          ...(keyEpoch !== null ? { key_epoch: keyEpoch } : {}),
        },
        {
          tlsVerify: options.tlsVerify,
          caCertPath: options.caCertPath,
          tlsPins: options.tlsPins,
        },
      );
      emitted++;
      continue;
    }

    const teamEpoch = objectField(record, 'team_epoch', false);
    if (teamEpoch) {
      const teamEpochId = String(numberOrStringField(teamEpoch, 'id'));
      const teamId = String(numberOrStringField(teamEpoch, 'team_id'));
      const epoch = numberField(teamEpoch, 'epoch');
      const fingerprint = stringField(teamEpoch, 'fingerprint');
      const encryptionPublicKeyJwk = objectField(teamEpoch, 'encryption_public_key_jwk');
      const signingPublicKeyJwk = objectField(teamEpoch, 'signing_public_key_jwk');
      await validateAndPinPublicEpoch(
        {
          platformEpochId: teamEpochId,
          workspaceId: options.workspaceId,
          subjectType: 'team',
          subjectId: teamId,
          epoch,
          schema: 'viewport.team_crypto_epoch/v1',
          fingerprint,
          encryptionPublicKeyJwk: encryptionPublicKeyJwk as JsonValue,
          signingPublicKeyJwk: signingPublicKeyJwk as JsonValue,
          previousEpochFingerprint: nullableStringField(teamEpoch, 'previous_epoch_fingerprint'),
          continuityPayload: objectField(
            teamEpoch,
            'continuity_payload',
            false,
          ) as JsonValue | null,
          continuitySignature: nullableStringField(teamEpoch, 'continuity_signature'),
          signedByEpochFingerprint: nullableStringField(teamEpoch, 'signed_by_epoch_fingerprint'),
        },
        options.home,
      );
      const recipientName = contextTeamEpochRecipientName({ teamEpochId, fingerprint });
      const result = await grantContextHpkeRecipient({
        contextResourceId: options.contextResourceId,
        actorName: options.actorName,
        recipientName,
        recipientHpkePublicKey: jwkPublicXToBase64(encryptionPublicKeyJwk),
        credentials: options.credentials,
        home: options.home,
      });
      const event = objectValue(result.event);
      const grantEventId = stringField(event, 'id');
      const grantPayload = objectField(event, 'grant', false);
      const keyEpoch = grantPayload ? numberField(grantPayload, 'keyEpoch', false) : null;

      const pushResult = await pushContextEvents({
        contextResourceId: options.contextResourceId,
        workspaceId: options.workspaceId,
        serverUrl: options.serverUrl,
        credential: options.credential,
        tlsVerify: options.tlsVerify,
        caCertPath: options.caCertPath,
        tlsPins: options.tlsPins,
        home: options.home,
        fetchImpl,
      });
      pushed += pushResult.accepted;

      await postJson(
        fetchImpl,
        contextMarkGrantEmittedUrl(options.serverUrl, options.workspaceId),
        {
          credential: options.credential,
          crypto_grant_id: stringField(record, 'id'),
          grant_event_id: grantEventId,
          recipient_identity_name: recipientName,
          recipient_type: 'team_epoch',
          recipient_epoch_id: teamEpochId,
          recipient_fingerprint: fingerprint,
          ...(keyEpoch !== null ? { key_epoch: keyEpoch } : {}),
        },
        {
          tlsVerify: options.tlsVerify,
          caCertPath: options.caCertPath,
          tlsPins: options.tlsPins,
        },
      );
      emitted++;
      continue;
    }

    missingIdentity++;
  }

  return { emitted, missingIdentity, pushed };
}

export async function processPendingContextRevocations(options: {
  contextResourceId: string;
  workspaceId: string;
  serverUrl: string;
  credential: string;
  actorName: string;
  credentials: ContextCredentials;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{ revoked: number; missingIdentity: number; pushed: number }> {
  const fetchImpl = options.fetchImpl ?? transportFetch;
  const response = await postJson(
    fetchImpl,
    contextPendingRevocationsUrl(options.serverUrl, options.workspaceId),
    {
      credential: options.credential,
      context_resource_id: options.contextResourceId,
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );

  const revocations = arrayField(response, 'revocations');
  let revoked = 0;
  let missingIdentity = 0;
  let pushed = 0;

  for (const revocation of revocations) {
    const record = objectValue(revocation);
    const recipientName = nullableStringField(record, 'recipient_identity_name');
    if (!recipientName) {
      missingIdentity++;
      continue;
    }

    const result = await revokeContextUser({
      contextResourceId: options.contextResourceId,
      actorName: options.actorName,
      recipientName,
      credentials: options.credentials,
      home: options.home,
    });
    const revokeEventId = stringField(objectValue(result.revokeEvent), 'id');
    const rotationEventIds = result.rotateEvents.map((event) =>
      stringField(objectValue(event), 'id'),
    );
    const rotationEvents = result.rotateEvents.map((event) => contextGrantRotationReceipt(event));
    const maxKeyEpoch = maxEventEpoch([result.revokeEvent, ...result.rotateEvents]);

    const pushResult = await pushContextEvents({
      contextResourceId: options.contextResourceId,
      workspaceId: options.workspaceId,
      serverUrl: options.serverUrl,
      credential: options.credential,
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
      home: options.home,
      fetchImpl,
    });
    pushed += pushResult.accepted;

    await postJson(
      fetchImpl,
      contextMarkRevokedUrl(options.serverUrl, options.workspaceId),
      {
        credential: options.credential,
        crypto_grant_id: stringField(record, 'id'),
        revoke_event_id: revokeEventId,
        rotation_event_ids: rotationEventIds,
        rotation_events: rotationEvents,
        ...(maxKeyEpoch !== null ? { key_epoch: maxKeyEpoch } : {}),
      },
      {
        tlsVerify: options.tlsVerify,
        caCertPath: options.caCertPath,
        tlsPins: options.tlsPins,
      },
    );
    revoked++;
  }

  return { revoked, missingIdentity, pushed };
}

function maxEventEpoch(events: unknown[]): number | null {
  let max: number | null = null;
  for (const event of events) {
    const epoch = numberField(objectValue(event), 'keyEpoch', false);
    if (epoch !== null) max = max === null ? epoch : Math.max(max, epoch);
  }
  return max;
}

function contextGrantRotationReceipt(event: unknown): {
  event_id: string;
  recipient_identity_name?: string;
} {
  const object = objectValue(event);
  const grant = objectField(object, 'grant', false);
  const recipientName = grant ? nullableStringField(grant, 'recipientName') : null;
  return {
    event_id: stringField(object, 'id'),
    ...(recipientName ? { recipient_identity_name: recipientName } : {}),
  };
}

async function contextGrantIdentitiesForWorkspace(options: {
  workspaceId: string;
  home: string;
}): Promise<ContextGrantIdentity[]> {
  const userEpoch = await getActiveLocalUserEpoch(options.workspaceId, options.home);
  const teamEpochs = await listActiveLocalTeamEpochs(options.workspaceId, options.home);
  return [
    ...(userEpoch?.platformEpochId
      ? [
          {
            kind: 'user_epoch' as const,
            name: contextUserEpochRecipientName({
              userEpochId: userEpoch.platformEpochId,
              fingerprint: userEpoch.fingerprint,
            }),
            hpkePrivateKey: jwkPrivateDToBase64(objectValue(userEpoch.encryptionPrivateKeyJwk)),
            signingPrivateKeyJwk: userEpoch.signingPrivateKeyJwk as JsonValue,
            signerFingerprint: userEpoch.fingerprint,
          },
        ]
      : []),
    ...teamEpochs.map((epoch) => ({
      kind: 'team_epoch' as const,
      name: contextTeamEpochRecipientName({
        teamEpochId:
          epoch.platformEpochId ?? `${epoch.platformTeamId ?? epoch.teamId}:${epoch.epoch}`,
        fingerprint: epoch.fingerprint,
      }),
      hpkePrivateKey: jwkPrivateDToBase64(objectValue(epoch.encryptionPrivateKeyJwk)),
      signingPrivateKeyJwk: epoch.signingPrivateKeyJwk as JsonValue,
      signerFingerprint: epoch.fingerprint,
    })),
  ];
}

type ContextGrantIdentity = {
  kind: 'user_epoch' | 'team_epoch';
  name: string;
  hpkePrivateKey: string;
  signingPrivateKeyJwk: JsonValue;
  signerFingerprint: string;
};

function contextGrantMaterializationReceipts(options: {
  workspaceId: string;
  contextResourceId: string;
  events: ContextSyncEvent[];
  grantIdentities: ContextGrantIdentity[];
}): SignedContextGrantMaterialization[] {
  const receipts: SignedContextGrantMaterialization[] = [];
  for (const event of options.events) {
    const match = grantEventRecipientMatch(event, options.grantIdentities);
    if (!match) continue;
    const keyEpoch = numberField(event, 'keyEpoch', false);
    const payload = contextGrantMaterializationPayload({
      workspaceId: options.workspaceId,
      contextResourceId: options.contextResourceId,
      grantEventId: stringField(event, 'id'),
      recipientName: match.identity.name,
      keyEpoch,
    });
    receipts.push(
      signContextGrantMaterialization({
        payload,
        signingPrivateKeyJwk: match.identity.signingPrivateKeyJwk,
        signedByEpochFingerprint: match.identity.signerFingerprint,
      }),
    );
  }
  return receipts;
}

function grantEventRecipientMatch(
  event: ContextSyncEvent,
  grantIdentities: ContextGrantIdentity[],
): { grant: Record<string, unknown>; identity: ContextGrantIdentity } | null {
  if (!CONTEXT_GRANT_EVENT_TYPES.has(event.type)) return null;
  const grant = (event as { grant?: unknown }).grant;
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return null;
  const recipientName = (grant as Record<string, unknown>).recipientName;
  if (typeof recipientName !== 'string' || recipientName === '') return null;
  const identity = grantIdentities.find((candidate) => candidate.name === recipientName);
  return identity ? { grant: grant as Record<string, unknown>, identity } : null;
}

function contextUserEpochRecipientName(input: {
  userEpochId: string;
  fingerprint: string;
}): string {
  return `user-epoch:${input.userEpochId}:${input.fingerprint}`;
}

function contextTeamEpochRecipientName(input: {
  teamEpochId: string;
  fingerprint: string;
}): string {
  return `team-epoch:${input.teamEpochId}:${input.fingerprint}`;
}

function jwkPublicXToBase64(jwk: Record<string, unknown>): string {
  const x = stringField(jwk, 'x');
  return Buffer.from(x, 'base64url').toString('base64');
}

function jwkPrivateDToBase64(jwk: Record<string, unknown>): string {
  const d = stringField(jwk, 'd');
  return Buffer.from(d, 'base64url').toString('base64');
}

function contextRuntimeUrl(
  serverUrl: string,
  workspaceId: string,
  operation: 'push' | 'pull',
): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/events/${operation}`;
}

function contextCandidatePreviewProofUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/candidates/preview-proof`;
}

function contextPendingGrantsUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/grants/pending`;
}

function contextMarkGrantEmittedUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/grants/mark-emitted`;
}

function contextPendingRevocationsUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/grants/revocations/pending`;
}

function contextMarkRevokedUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/grants/mark-revoked`;
}

function contextGrantMaterializedUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/grants/materialized`;
}

async function postJson(
  fetchImpl: typeof transportFetch,
  url: string,
  body: Record<string, unknown>,
  transportOptions: {
    tlsVerify?: TlsVerifyMode;
    caCertPath?: string;
    tlsPins?: string[];
  } = {},
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      [TRUSTED_EDGE_CRYPTO_PROTOCOL_HEADER]: TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
    timeoutMs: 5_000,
    ...transportOptions,
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const reason =
      typeof payload === 'object' && payload && 'reason' in payload
        ? String((payload as { reason?: unknown }).reason)
        : `${response.status} ${response.statusText}`;
    throw new Error(`Context sync request failed: ${reason}`);
  }

  return payload;
}

function extractPulledRecords(response: unknown): ContextSyncPullRecord[] {
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray((response as { data?: unknown }).data)
  ) {
    throw new Error('Context sync pull response did not include a data array');
  }

  return (response as { data: Array<{ signed_event?: unknown }> }).data.map((item, index) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !item.signed_event ||
      typeof item.signed_event !== 'object'
    ) {
      throw new Error(`Context sync pull response item ${index} did not include a signed_event`);
    }
    return {
      signedEvent: item.signed_event as ContextSyncEvent,
      receivedAt:
        typeof (item as { received_at?: unknown }).received_at === 'string'
          ? (item as { received_at: string }).received_at
          : undefined,
    };
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object value');
  }
  return value as Record<string, unknown>;
}

function objectField(
  value: unknown,
  field: string,
  required: false,
): Record<string, unknown> | null;
function objectField(value: unknown, field: string, required?: true): Record<string, unknown>;
function objectField(
  value: unknown,
  field: string,
  required = true,
): Record<string, unknown> | null {
  const object = objectValue(value);
  const child = object[field];
  if (child === undefined || child === null) {
    if (!required) return null;
  }
  return objectValue(child);
}

function arrayField(value: unknown, field: string): unknown[] {
  const object = objectValue(value);
  const child = object[field];
  if (!Array.isArray(child)) {
    throw new Error(`Expected ${field} to be an array`);
  }
  return child;
}

function nullableStringField(value: unknown, field: string): string | null {
  const object = objectValue(value);
  const child = object[field];
  if (child === undefined || child === null) return null;
  if (typeof child !== 'string') {
    throw new Error(`Expected ${field} to be a string`);
  }
  return child;
}

function stringField(value: unknown, field: string): string {
  const object = objectValue(value);
  const child = object[field];
  if (typeof child !== 'string' || child.length === 0) {
    throw new Error(`Expected ${field} to be a non-empty string`);
  }
  return child;
}

function extractPulledCandidateDecisions(
  response: unknown,
  trustedDecisionKeys?: Record<string, string>,
): ContextCandidateDecisionPullRecord[] {
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray((response as { candidate_decisions?: unknown }).candidate_decisions)
  ) {
    return [];
  }

  return (response as { candidate_decisions: unknown[] }).candidate_decisions.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Context sync pull decision ${index} was not an object`);
    }
    const record = item as Partial<ContextCandidateDecisionPullRecord>;
    if (record.schema_version !== 'viewport.context_candidate_decision/v1') {
      throw new Error(`Context sync pull decision ${index} had an unsupported schema`);
    }
    if (record.decision !== 'approved' && record.decision !== 'rejected') {
      throw new Error(`Context sync pull decision ${index} had an unsupported decision`);
    }
    if (!record.repo_id || !record.candidate_event_id) {
      throw new Error(`Context sync pull decision ${index} was missing candidate identity`);
    }
    verifyContextCandidateDecision(
      record as ContextCandidateDecisionPullRecord,
      trustedDecisionKeys,
    );

    return record as ContextCandidateDecisionPullRecord;
  });
}

function latestReceivedAt(
  records: ContextSyncPullRecord[],
  decisions: ContextCandidateDecisionPullRecord[] = [],
): string | undefined {
  return [
    ...records
      .map((record) => record.receivedAt)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...decisions
      .map((record) => record.decided_at)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  ]
    .sort()
    .at(-1);
}

function numberField(response: unknown, field: string, required: false): number | null;
function numberField(response: unknown, field: string, required?: true): number;
function numberField(response: unknown, field: string, required = true): number | null {
  const object = objectValue(response);
  const value = object[field];
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new Error(`Context sync response did not include ${field}`);
  }
  if (typeof value !== 'number') {
    throw new Error(`Context sync response ${field} must be a number`);
  }
  return value;
}

function numberOrStringField(response: unknown, field: string): number | string {
  const object = objectValue(response);
  const value = object[field];
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`Context sync response ${field} must be a number or string`);
  }
  return value;
}
