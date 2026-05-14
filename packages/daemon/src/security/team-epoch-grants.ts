import { transportFetch, type TlsVerifyMode } from '../cli/network.js';
import { configDir } from '../core/config.js';
import {
  getLocalTeamEpochByPlatformId,
  getLocalUserEpochByPlatformId,
  upsertLocalTeamEpoch,
  type LocalTeamCryptoEpoch,
} from './epoch-store.js';
import {
  signTeamEpochMemberMaterialization,
  teamEpochMemberMaterializationPayload,
  TRUSTED_EDGE_CRYPTO_PROTOCOL_HEADER,
  TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
  unwrapJsonFromX25519Envelope,
  wrapJsonForX25519Recipient,
} from './epoch-protocol.js';
import { validateAndPinPublicEpoch } from './epoch-public-pins.js';
import type { CryptoEpochSyncTarget } from './epoch-sync.js';
import {
  arrayField,
  objectField,
  publicUserEpochPayload,
  teamEpochMemberGrantAad,
  teamMaterialPayload,
  teamMemberGrantPayload,
  type PublicUserEpoch,
  type TeamMemberGrantPayload,
} from './team-epoch-grant-payloads.js';

export async function grantTeamEpochToUserEpoch(options: {
  target: CryptoEpochSyncTarget;
  teamCryptoEpochId: string;
  recipientUserCryptoEpochId: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<TeamMemberGrantPayload> {
  const teamEpoch = await getLocalTeamEpochByPlatformId(
    options.target.workspaceId,
    options.teamCryptoEpochId,
    options.home,
  );
  if (!teamEpoch?.platformEpochId) {
    throw new Error('Active local team epoch with platform id is required before granting it.');
  }
  const recipient = await fetchPublicUserEpoch(options);
  const aad = teamEpochMemberGrantAad({ teamEpoch, recipient });
  const encryptedPayload = wrapJsonForX25519Recipient({
    recipientPublicKeyJwk: recipient.encryption_public_key_jwk,
    aad,
    payload: {
      schema: 'viewport.team_epoch_member_material/v1',
      workspaceId: teamEpoch.workspaceId,
      teamId: teamEpoch.teamId,
      platformTeamId: teamEpoch.platformTeamId ?? null,
      platformEpochId: teamEpoch.platformEpochId,
      epoch: teamEpoch.epoch,
      fingerprint: teamEpoch.fingerprint,
      encryptionPublicKeyJwk: teamEpoch.encryptionPublicKeyJwk,
      encryptionPrivateKeyJwk: teamEpoch.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: teamEpoch.signingPublicKeyJwk,
      signingPrivateKeyJwk: teamEpoch.signingPrivateKeyJwk,
      previousEpochFingerprint: teamEpoch.previousEpochFingerprint ?? null,
    },
  });

  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/team-epochs/${encodeURIComponent(
      options.teamCryptoEpochId,
    )}/member-grants`,
    {
      credential: options.target.credential,
      recipient_user_crypto_epoch_id: options.recipientUserCryptoEpochId,
      aad,
      encrypted_payload: encryptedPayload,
    },
    options.target,
  );
  return teamMemberGrantPayload(objectField(response, 'data'));
}

export async function grantTeamEpochToWorkspaceUserEpochs(options: {
  target: CryptoEpochSyncTarget;
  teamCryptoEpochId: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{
  attempted: number;
  granted: number;
  skipped: number;
  grants: TeamMemberGrantPayload[];
}> {
  const fetchImpl = options.fetchImpl ?? transportFetch;
  const response = await getJson(
    fetchImpl,
    `${runtimeBaseUrl(options.target)}/crypto/epochs`,
    options.target,
  );
  const userEpochs = arrayField(objectField(response, 'data'), 'user_epochs').map((item) =>
    publicUserEpochPayload(item),
  );
  const grants: TeamMemberGrantPayload[] = [];
  let skipped = 0;

  for (const userEpoch of userEpochs) {
    try {
      grants.push(
        await grantTeamEpochToUserEpoch({
          target: options.target,
          teamCryptoEpochId: options.teamCryptoEpochId,
          recipientUserCryptoEpochId: userEpoch.id,
          home: options.home,
          fetchImpl,
        }),
      );
    } catch (error) {
      if (isExpectedNonTeamRecipientError(error)) {
        skipped++;
        continue;
      }
      throw error;
    }
  }

  return {
    attempted: userEpochs.length,
    granted: grants.length,
    skipped,
    grants,
  };
}

export async function acceptTeamEpochMemberGrants(options: {
  target: CryptoEpochSyncTarget;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{ accepted: number; teamEpochs: LocalTeamCryptoEpoch[] }> {
  const response = await getJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/team-epoch-member-grants`,
    options.target,
  );
  const grants = arrayField(response, 'data').map((item) => teamMemberGrantPayload(item));
  const teamEpochs: LocalTeamCryptoEpoch[] = [];
  for (const grant of grants) {
    const localUserEpoch = await getLocalUserEpochByPlatformId(
      options.target.workspaceId,
      grant.recipient_user_crypto_epoch_id,
      options.home,
    );
    if (!localUserEpoch) continue;
    const payload = unwrapJsonFromX25519Envelope({
      recipientPrivateKeyJwk: localUserEpoch.encryptionPrivateKeyJwk,
      envelope: grant.encrypted_payload,
      aad: grant.aad,
    });
    const material = teamMaterialPayload(payload);
    const teamEpoch = await upsertLocalTeamEpoch(
      {
        workspaceId: material.workspaceId,
        teamId: material.teamId,
        platformTeamId: material.platformTeamId,
        platformEpochId: material.platformEpochId,
        epoch: material.epoch,
        schema: 'viewport.team_crypto_epoch/v1',
        status: 'active',
        encryptionPublicKeyJwk: material.encryptionPublicKeyJwk,
        encryptionPrivateKeyJwk: material.encryptionPrivateKeyJwk,
        signingPublicKeyJwk: material.signingPublicKeyJwk,
        signingPrivateKeyJwk: material.signingPrivateKeyJwk,
        fingerprint: material.fingerprint,
        previousEpochFingerprint: material.previousEpochFingerprint,
      },
      options.home ?? configDir(),
    );
    await postJson(
      options.fetchImpl ?? transportFetch,
      `${runtimeBaseUrl(options.target)}/crypto/team-epoch-member-grants/${encodeURIComponent(
        grant.id,
      )}/materialized`,
      {
        credential: options.target.credential,
        receipt: signTeamEpochMemberMaterialization({
          payload: teamEpochMemberMaterializationPayload({
            workspaceId: material.workspaceId,
            grantId: grant.id,
            teamCryptoEpochId: material.platformEpochId,
            teamEpochFingerprint: material.fingerprint,
            recipientUserCryptoEpochId: grant.recipient_user_crypto_epoch_id,
            recipientUserEpochFingerprint: localUserEpoch.fingerprint,
          }),
          signingPrivateKeyJwk: material.signingPrivateKeyJwk,
          signedByTeamEpochFingerprint: material.fingerprint,
        }),
      },
      options.target,
    );
    teamEpochs.push(teamEpoch);
  }
  return { accepted: teamEpochs.length, teamEpochs };
}

async function fetchPublicUserEpoch(options: {
  target: CryptoEpochSyncTarget;
  recipientUserCryptoEpochId: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<PublicUserEpoch> {
  const response = await getJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/epochs`,
    options.target,
  );
  const userEpochs = arrayField(objectField(response, 'data'), 'user_epochs').map((item) =>
    publicUserEpochPayload(item),
  );
  const epoch = userEpochs.find((item) => item.id === options.recipientUserCryptoEpochId);
  if (!epoch) throw new Error('Recipient user epoch not found in workspace epoch feed.');
  await validateAndPinPublicEpoch(
    {
      platformEpochId: epoch.id,
      workspaceId: epoch.workspace_id,
      subjectType: 'user',
      subjectId: String(epoch.user_id),
      epoch: epoch.epoch,
      schema: 'viewport.user_crypto_epoch/v1',
      fingerprint: epoch.fingerprint,
      encryptionPublicKeyJwk: epoch.encryption_public_key_jwk,
      signingPublicKeyJwk: epoch.signing_public_key_jwk,
      previousEpochFingerprint: epoch.previous_epoch_fingerprint ?? null,
      continuityPayload: epoch.continuity_payload ?? null,
      continuitySignature: epoch.continuity_signature ?? null,
      signedByEpochFingerprint: epoch.signed_by_epoch_fingerprint ?? null,
    },
    options.home,
  );
  return epoch;
}

function runtimeBaseUrl(target: CryptoEpochSyncTarget): string {
  return `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
    target.workspaceId,
  )}`;
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
    headers: trustedEdgeCryptoHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    timeoutMs: 5_000,
    tlsVerify: transportOptions.tlsVerify,
    caCertPath: transportOptions.caCertPath,
    tlsPins: transportOptions.tlsPins,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(responseError(payload, response));
  return payload;
}

async function getJson(
  fetchImpl: typeof transportFetch,
  url: string,
  transportOptions: CryptoEpochSyncTarget,
): Promise<unknown> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set('credential', transportOptions.credential);
  const response = await fetchImpl(requestUrl.toString(), {
    method: 'GET',
    headers: trustedEdgeCryptoHeaders(),
    timeoutMs: 5_000,
    tlsVerify: transportOptions.tlsVerify,
    caCertPath: transportOptions.caCertPath,
    tlsPins: transportOptions.tlsPins,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(responseError(payload, response));
  return payload;
}

function trustedEdgeCryptoHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: 'application/json',
    [TRUSTED_EDGE_CRYPTO_PROTOCOL_HEADER]: TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
    ...extra,
  };
}

function responseError(payload: unknown, response: Response): string {
  const message =
    payload && typeof payload === 'object' && 'message' in payload
      ? String((payload as { message?: unknown }).message)
      : `${response.status} ${response.statusText}`;
  return `Team epoch grant sync failed: ${message}`;
}

function isExpectedNonTeamRecipientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('Recipient user is not a team member');
}
