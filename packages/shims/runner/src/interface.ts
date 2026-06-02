// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

export interface RunnerProvisionRequest {
  tenantId: string;
  workspaceId: string;
  runId: string;
  leaseId: string;
  image?: string;
  env: Record<string, string>;
  egressAllowlist: string[];
}

export interface RunnerSession {
  id: string;
  startedAt: Date;
  endpoint?: string;
}

export interface RunnerProvider {
  readonly id: string;
  provision(request: RunnerProvisionRequest): Promise<RunnerSession>;
  teardown(sessionId: string): Promise<{ tornDown: boolean }>;
}
