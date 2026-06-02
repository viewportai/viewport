// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

export interface SecretMaterializationRequest {
  tenantId: string;
  workspaceId: string;
  runId: string;
  leaseId: string;
  secretRef: string;
  purpose: 'llm_provider' | 'runner_credential' | (string & {});
}

export interface SecretMaterializationResult {
  value: string;
  expiresAt: Date;
  auditRef: string;
}

export interface SecretsProvider {
  readonly id: string;
  materialize(request: SecretMaterializationRequest): Promise<SecretMaterializationResult>;
  rotate?(secretRef: string): Promise<{ auditRef: string }>;
  revoke?(secretRef: string): Promise<{ auditRef: string }>;
}
