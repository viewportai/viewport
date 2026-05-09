import { createRequire } from 'node:module';
import path from 'node:path';
import {
  CONTEXT_EVENT_SCHEMA_VERSION,
  DEVICE_APPROVAL_CODE,
  SERVER_SYNC_MODE,
  type ContextCredentials,
  type ContextIdentitySecretStore,
  type ContextKeyStore,
  type ContextVaultConstructor,
  type ContextVaultInstance,
} from './local-edge-types.js';
import { writeContextMetadata } from './local-edge-metadata.js';

const require = createRequire(import.meta.url);
const { ContextVault, MacOsKeychainIdentitySecretStore, ResolverPinMismatchError } =
  require('@viewportai/context-engine') as {
    ContextVault: ContextVaultConstructor;
    MacOsKeychainIdentitySecretStore: new (options?: {
      namespace?: string;
      service?: string;
    }) => ContextIdentitySecretStore;
    ResolverPinMismatchError: new (mismatches: unknown[]) => Error;
  };

export function createVault(
  home: string,
  keyStore: ContextKeyStore = 'file',
): ContextVaultInstance {
  return new ContextVault(home, {
    keyStore: createIdentitySecretStore(home, keyStore),
  });
}

export function createIdentitySecretStore(
  home: string,
  keyStore: ContextKeyStore,
): ContextIdentitySecretStore | null {
  if (keyStore === 'file') return null;
  if (keyStore === 'macos-keychain') {
    return new MacOsKeychainIdentitySecretStore({
      namespace: `vpd:${path.resolve(home)}`,
      service: 'ai.viewport.vpd.context',
    });
  }
  throw new Error(`Unsupported context key store: ${String(keyStore)}`);
}

export function assertCredentials(
  vault: ContextVaultInstance,
  userName: string,
  credentials: ContextCredentials,
): void {
  vault.recoverUserIdentity({ userName, ...credentials });
}

export function hasApprovedDeviceCapability(
  vault: ContextVaultInstance,
  options: { userName: string; deviceName: string },
): boolean {
  try {
    const identity = vault.getIdentity(options.deviceName) as Record<string, unknown>;
    return (
      identity['deviceState'] === 'approved' &&
      identity['grantRecipientName'] === options.userName &&
      typeof identity['grantHpkePrivateKey'] === 'string'
    );
  } catch (error) {
    if (!isUnknownIdentityError(error)) {
      throw error;
    }
    return false;
  }
}

export function assertCredentialsOrApprovedDevice(
  vault: ContextVaultInstance,
  options: {
    userName: string;
    deviceName: string;
    credentials: ContextCredentials;
  },
): void {
  if (hasApprovedDeviceCapability(vault, options)) return;
  try {
    assertCredentials(vault, options.userName, options.credentials);
    return;
  } catch (error) {
    if (!isUnknownUserError(error)) {
      throw error;
    }
  }
  throw new Error(`Unknown user: ${options.userName}`);
}

export async function ensureUserAndDevice(
  vault: ContextVaultInstance,
  options: { userName: string; deviceName: string; credentials: ContextCredentials },
): Promise<void> {
  ensureUser(vault, options.userName, options.credentials);
  await ensureDevice(vault, options);
}

export async function ensureUserOrApprovedDevice(
  vault: ContextVaultInstance,
  options: { userName: string; deviceName: string; credentials: ContextCredentials },
): Promise<void> {
  if (hasApprovedDeviceCapability(vault, options)) return;
  await ensureUserAndDevice(vault, options);
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
    contextResourceId: string;
    userName: string;
    deviceName: string;
    home: string;
    keyStore: ContextKeyStore;
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
  await writeContextMetadata(
    {
      schemaVersion: CONTEXT_EVENT_SCHEMA_VERSION,
      engine: '@viewportai/context-engine',
      contextResourceId: options.contextResourceId,
      repoId: options.repoId,
      userName: options.userName,
      deviceName: options.deviceName,
      keyStore: options.keyStore,
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
