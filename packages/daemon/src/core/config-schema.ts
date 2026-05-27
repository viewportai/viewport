import { z } from 'zod';

const PartialGitTrackerSchema = z
  .object({
    enabled: z.boolean().optional(),
    commitOn: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    autoSquashOnComplete: z.boolean().optional(),
    branchPrefix: z.string().optional(),
    commitAuthor: z.string().optional(),
    maxCommitsPerSession: z.number().int().positive().optional(),
    worktreeRoot: z.string().optional(),
  })
  .strict();

const PartialPermissionsSchema = z
  .object({
    autoApprove: z.array(z.string()).optional(),
    requireApproval: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

const PartialSessionConfigSchema = z
  .object({
    agent: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(256).optional(),
    sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    approvalPolicy: z.enum(['never', 'on-request', 'on-failure', 'untrusted']).optional(),
    executionMode: z.enum(['plan', 'read_only', 'implement', 'review']).optional(),
    allowedTools: z.array(z.string().trim().min(1)).optional(),
    resourceId: z.string().min(1).max(256).optional(),
    gitTracker: PartialGitTrackerSchema.optional(),
    permissions: PartialPermissionsSchema.optional(),
    costCapUsd: z.number().nonnegative().optional(),
    trust: z.enum(['operator', 'automated', 'external']).optional(),
  })
  .strict();

const PartialRelayBindingSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoint: z.string().optional(),
    serverUrl: z.string().optional(),
    workspaceId: z.string().optional(),
    installId: z.string().optional(),
    runtimeTargetId: z.string().optional(),
    machineId: z.string().optional(),
    machineName: z.string().max(80).optional(),
    issueToken: z.string().optional(),
    tlsVerify: z.enum(['auto', '0', '1']).optional(),
    caCertPath: z.string().optional(),
    tlsPins: z.array(z.string()).optional(),
    tokenIssuer: z.string().optional(),
    tokenAudience: z.string().optional(),
    tokenJwksUrl: z.string().optional(),
    signingKeys: z.record(z.string(), z.string()).optional(),
    tokenClockSkewSec: z.number().int().nonnegative().optional(),
  })
  .strict();

const WorkerCapabilityAgentSchema = z
  .object({
    id: z.string().min(1).max(128),
    displayName: z.string().max(256).optional(),
    tier: z.enum(['sdk', 'pty']).optional(),
    available: z.boolean(),
  })
  .strict();

export const ViewportConfigSchema = z
  .object({
    defaults: PartialSessionConfigSchema.optional(),
    directories: z
      .record(
        z.string(),
        z
          .object({
            path: z.string().min(1),
            config: PartialSessionConfigSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    machineId: z.string().optional(),
    daemon: z
      .object({
        listen: z.string().optional(),
        profile: z.enum(['local', 'lan', 'relay']).optional(),
        allowedHosts: z.union([z.array(z.string()), z.literal(true)]).optional(),
        allowedOrigins: z.union([z.array(z.string()), z.literal(true)]).optional(),
        authEnabled: z.boolean().optional(),
        logFile: z.string().optional(),
        server: z
          .object({
            url: z.string().optional(),
            appUrl: z.string().optional(),
            tlsVerify: z.enum(['auto', '0', '1']).optional(),
            caCertPath: z.string().optional(),
            tlsPins: z.array(z.string()).optional(),
            contextCandidateDecisionKeys: z.record(z.string(), z.string()).optional(),
          })
          .strict()
          .optional(),
        relay: z
          .object({
            enabled: z.boolean().optional(),
            bindings: z.array(PartialRelayBindingSchema).optional(),
            endpoint: z.string().optional(),
            serverUrl: z.string().optional(),
            workspaceId: z.string().optional(),
            installId: z.string().optional(),
            runtimeTargetId: z.string().optional(),
            machineId: z.string().optional(),
            machineName: z.string().max(80).optional(),
            issueToken: z.string().optional(),
            tlsVerify: z.enum(['auto', '0', '1']).optional(),
            caCertPath: z.string().optional(),
            tlsPins: z.array(z.string()).optional(),
            tokenIssuer: z.string().optional(),
            tokenAudience: z.string().optional(),
            tokenJwksUrl: z.string().optional(),
            signingKeys: z.record(z.string(), z.string()).optional(),
            tokenClockSkewSec: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        worker: z
          .object({
            lifecycle: z.enum(['persistent', 'ephemeral']).optional(),
            transport: z.enum(['polling', 'relay', 'inbound']).optional(),
            serverUrl: z.string().optional(),
            appUrl: z.string().optional(),
            workspaceRoot: z.string().optional(),
            logsDir: z.string().optional(),
            cacheDir: z.string().optional(),
            stateDir: z.string().optional(),
            identityKeyPath: z.string().optional(),
            publicKeyFingerprint: z.string().optional(),
            capabilities: z
              .object({
                agents: z.array(WorkerCapabilityAgentSchema).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
