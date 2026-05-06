import { createRequire } from 'node:module';
import {
  CONTEXT_EVENT_SCHEMA_VERSION,
  DEVICE_APPROVAL_CODE,
  SERVER_SYNC_MODE,
  type ContextCredentials,
  type ContextVaultConstructor,
  type ContextVaultInstance,
} from './local-edge-types.js';
import { writeProjectMetadata } from './local-edge-metadata.js';

const require = createRequire(import.meta.url);
const { ContextVault, ResolverPinMismatchError } = require('@viewportai/context-engine') as {
  ContextVault: ContextVaultConstructor;
  ResolverPinMismatchError: new (mismatches: unknown[]) => Error;
};

export function createVault(home: string): ContextVaultInstance {
  return new ContextVault(home);
}

export function assertCredentials(
  vault: ContextVaultInstance,
  userName: string,
  credentials: ContextCredentials,
): void {
  vault.recoverUserIdentity({ userName, ...credentials });
}

export async function ensureUserAndDevice(
  vault: ContextVaultInstance,
  options: { userName: string; deviceName: string; credentials: ContextCredentials },
): Promise<void> {
  ensureUser(vault, options.userName, options.credentials);
  await ensureDevice(vault, options);
}

export async function ensureDevice(
  vault: ContextVaultInstance,
  options: { userName: string; deviceName: string; credentials: ContextCredentials },
): Promise<void> {
  try {
    vault.getIdentity(options.deviceName);
    return;
  } catch (error) {
    if (!isUnknownIdentityError(error)) {
      throw error;
    }
  }
  const request = vault.createDeviceApprovalRequest({
    deviceName: options.deviceName,
    code: DEVICE_APPROVAL_CODE,
  });
  const approval = await vault.approveDeviceRequest({
    userName: options.userName,
    request,
    ...options.credentials,
    code: DEVICE_APPROVAL_CODE,
  });
  await vault.acceptDeviceApproval({
    userName: options.userName,
    deviceName: options.deviceName,
    approval,
    code: DEVICE_APPROVAL_CODE,
  });
}

export async function ensureRepo(
  vault: ContextVaultInstance,
  options: {
    repoId: string;
    projectId: string;
    userName: string;
    deviceName: string;
    home: string;
  },
): Promise<void> {
  try {
    vault.getRepoMetadata(options.repoId);
  } catch (error) {
    if (!isUnknownRepoError(error)) {
      throw error;
    }
    await vault.createRepoHpke(options.repoId, options.userName, { actorName: options.deviceName });
  }

  const metadata = vault.getRepoMetadata(options.repoId);
  await writeProjectMetadata(
    {
      schemaVersion: CONTEXT_EVENT_SCHEMA_VERSION,
      engine: '@viewportai/context-engine',
      projectId: options.projectId,
      repoId: options.repoId,
      userName: options.userName,
      deviceName: options.deviceName,
      serverSync: SERVER_SYNC_MODE,
      createdAt: metadata.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    options.home,
  );
}

export function isResolverPinMismatch(error: unknown): boolean {
  return error instanceof ResolverPinMismatchError;
}

function ensureUser(
  vault: ContextVaultInstance,
  userName: string,
  credentials: ContextCredentials,
): void {
  try {
    vault.recoverUserIdentity({ userName, ...credentials });
    return;
  } catch (error) {
    if (!isUnknownUserError(error)) {
      throw error;
    }
  }
  vault.createUser({ userName, ...credentials });
}

function isUnknownUserError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Unknown user:');
}

function isUnknownIdentityError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Unknown identity:');
}

function isUnknownRepoError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Unknown repo:');
}
