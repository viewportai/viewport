import { z } from 'zod';

const ResourceRefSchema = z.union([
  z.string().trim().min(1).max(512),
  z
    .object({
      id: z.string().trim().min(1).max(512),
      required: z.boolean().optional(),
    })
    .strict(),
]);

export const ViewportConfigSchema = z
  .object({
    $schema: z.string().url().optional(),
    version: z.literal(1).optional().default(1),
    name: z.string().trim().min(1).max(256).optional(),
    resources: z
      .object({
        contexts: z.array(ResourceRefSchema).max(100).optional(),
        workflows: z.array(ResourceRefSchema).max(100).optional(),
        plans: z.array(ResourceRefSchema).max(100).optional(),
        agentProfiles: z.array(ResourceRefSchema).max(100).optional(),
      })
      .strict()
      .optional(),
    defaults: z
      .object({
        inboxRoute: z.string().trim().min(1).max(256).optional(),
        visibility: z.enum(['private', 'team', 'organization']).optional(),
        contextCandidateReview: z.string().trim().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    scope: z
      .object({
        includeChildren: z.boolean().optional(),
        maxDepth: z.number().int().min(0).max(5).optional(),
        exclude: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export type ViewportConfigInput = z.infer<typeof ViewportConfigSchema>;
