import type { WorkflowInputValue } from './run-types.js';

export type WorkflowExecutorTargetKind =
  | 'local_private'
  | 'local_sandbox'
  | 'managed'
  | 'self_hosted'
  | 'ci';

export type WorkflowExecutorCapability =
  | 'agent.prompt'
  | 'artifacts'
  | 'cancel'
  | 'files.read'
  | 'files.write'
  | 'network.egress'
  | 'resume'
  | 'secrets'
  | 'shell'
  | 'worktree';

export type WorkflowTriggerDefinition =
  | {
      type: 'manual';
      title?: string;
      description?: string;
      inputs?: Record<string, WorkflowInputValue>;
    }
  | {
      type: 'webhook';
      title?: string;
      provider?: string;
      route?: string;
      eventTypes?: string[];
      signature?: {
        algorithm: 'hmac-sha256';
        header: string;
        timestampHeader?: string;
        toleranceSeconds?: number;
      };
      map?: Record<string, string>;
    }
  | {
      type: 'schedule';
      title?: string;
      cron: string;
      timezone?: string;
      missedRun?: 'skip' | 'catch_up_once' | 'route_to_inbox';
    };

export interface WorkflowRunnerRequirementV2 {
  kind?: 'paired_daemon' | 'self_hosted_runner';
  target?: WorkflowExecutorTargetKind;
  capabilities?: WorkflowExecutorCapability[];
  labels?: string[];
  profile?: string;
  leaseSeconds?: number;
}

export interface WorkflowPolicyDefinition {
  run?: {
    allowed?: string[];
    requireOnlineRunner?: boolean;
  };
  approve?: {
    allowed?: string[];
    minApprovals?: number;
  };
  sideEffects?: {
    requireApproval?: boolean;
    allowedAdapters?: string[];
  };
  budget?: {
    maxTokens?: number;
    tokens?: number;
    maxCostUsd?: number;
    usd?: number;
    approvalThresholds?: {
      tokens?: number;
      costUsd?: number;
    };
  };
  maxDurationSeconds?: number;
}

export interface WorkflowNotificationDefinition {
  inbox?:
    | Array<'approval_requested' | 'run_failed' | 'runner_offline' | 'action_failed'>
    | {
        slack?: {
          enabled?: boolean;
          credential_ref?: string;
          credential?: string;
          delivery?:
            | 'source_thread'
            | 'dm_assignee'
            | 'dm_requester'
            | 'channel'
            | Array<'source_thread' | 'dm_assignee' | 'dm_requester' | 'channel'>;
          events?: string[];
          channel?: string;
          template?: string;
        };
      };
  email?: Array<'approval_requested' | 'run_failed' | 'run_completed'>;
  webhook?: string[];
  sourceAccepted?:
    | boolean
    | {
        enabled?: boolean;
        provider?: string;
        credential_ref?: string;
        credential?: string;
        delivery?: 'source_thread' | 'channel' | 'dm_requester';
        mode?: 'source_thread' | 'channel' | 'dm_requester';
        channel?: string;
        thread_ts?: string;
        user_id?: string;
        template?: string;
        onFailure?: 'continue' | 'fail_run';
        failurePolicy?: 'continue' | 'fail_run';
      };
}

export interface WorkflowDataCaptureDefinition {
  logs?: 'compact' | 'full' | 'off';
  artifacts?: boolean;
  contextEvidence?: boolean;
  approvalPackets?: boolean;
}

export interface WorkflowContextReference {
  ref?: string;
  source?: string;
  package?: string;
  artifact?: string;
  as?: string;
  required?: boolean;
  description?: string;
  refresh?: 'manual' | 'before_run' | 'on_demand';
  max_items?: number;
  maxItems?: number;
}

export type WorkflowContext = Array<string | WorkflowContextReference>;
