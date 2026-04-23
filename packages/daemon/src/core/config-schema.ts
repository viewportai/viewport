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
    gitTracker: PartialGitTrackerSchema.optional(),
    permissions: PartialPermissionsSchema.optional(),
    costCapUsd: z.number().nonnegative().optional(),
    trust: z.enum(['operator', 'automated', 'external']).optional(),
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
            tlsVerify: z.enum(['auto', '0', '1']).optional(),
            caCertPath: z.string().optional(),
            tlsPins: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        relay: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            serverUrl: z.string().optional(),
            workspaceId: z.string().optional(),
            installId: z.string().optional(),
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
      })
      .strict()
      .optional(),
  })
  .strict();
