import type { SessionContextProviderManifest } from '../config-resolution/index.js';

export type ContextCandidateSourceKind = 'workflow' | 'plan' | 'integration';

export type ContextProviderResult = {
  id: string;
  provider_id: string;
  provider: string;
  privacy: string;
  title: string;
  body: string;
  digest?: string;
  source?: string;
  score?: number;
};

export type ContextProviderSearchInput = {
  provider: SessionContextProviderManifest;
  query: string;
  sizeBudgetBytes?: number;
  actorName: string;
  credentials?: { passphrase: string; recoveryCode: string };
  home?: string;
};

export type ContextProviderGetInput = ContextProviderSearchInput & {
  entryId: string;
};

export type ContextProviderProposeInput = {
  provider: SessionContextProviderManifest;
  manifestDigest: string;
  actorName: string;
  title: string;
  body: string;
  sourceKind: ContextCandidateSourceKind;
  credentials: { passphrase: string; recoveryCode: string };
  home?: string;
  sourceProvider?: SessionContextProviderManifest;
  source?: string;
};

export type ContextProviderProposeResult = {
  candidate_id: string;
  payload_digest: string;
  status?: string;
  pull_request_url?: string;
  branch?: string;
  source?: string;
};

export type ContextProviderApplyApprovedUpdateInput = {
  provider: SessionContextProviderManifest;
  proposalId: string;
  patch: {
    mode?: string;
    text?: string;
    beforeDigest?: string;
    patchDigest?: string;
  };
  actorName: string;
};

export type ContextProviderApplyApprovedUpdateResult = {
  status: 'succeeded' | 'failed';
  provider_reference?: string;
  provider_url?: string;
  payload: Record<string, unknown>;
};

export interface ContextProviderAdapter {
  kind: SessionContextProviderManifest['provider'];
  search?: (input: ContextProviderSearchInput) => Promise<ContextProviderResult[]>;
  get?: (input: ContextProviderGetInput) => Promise<ContextProviderResult | undefined>;
  propose?: (input: ContextProviderProposeInput) => Promise<ContextProviderProposeResult>;
  applyApprovedUpdate?: (
    input: ContextProviderApplyApprovedUpdateInput,
  ) => Promise<ContextProviderApplyApprovedUpdateResult>;
}
