export interface WorkflowRunEvent {
  id: string;
  runId: string;
  timestamp: number;
  type:
    | 'run-created'
    | 'run-started'
    | 'run-blocked'
    | 'run-completed'
    | 'run-failed'
    | 'run-canceled'
    | 'run-rerun-requested'
    | 'run-resume-paused'
    | 'node-started'
    | 'node-log'
    | 'node-output'
    | 'node-skipped'
    | 'plan-proposed'
    | 'artifact-collected'
    | 'artifact-missing'
    | 'approval-requested'
    | 'approval-resolved'
    | 'gate-blocked'
    | 'gate-passed'
    | 'node-completed'
    | 'node-failed'
    | 'session-started'
    | 'session-idle'
    | 'session-ended'
    | 'execution-policy-selected'
    | 'context-manifest-resolved'
    | 'hook-fired'
    | 'inline-agent-started'
    | 'inline-agent-completed'
    | 'inline-agent-failed'
    | 'loop-iteration-started'
    | 'loop-iteration-completed'
    | 'loop-iteration-failed'
    | 'node-retry'
    | 'subflow-child-started'
    | 'subflow-child-completed'
    | 'subflow-child-failed'
    | 'subflow-child-skipped';
  nodeId?: string;
  message: string;
  data?: Record<string, unknown>;
}
