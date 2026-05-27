export interface WorkflowInlineAgentDefinition {
  title?: string;
  prompt: string;
  agent?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  executionMode?: 'plan' | 'read_only' | 'implement' | 'review';
  allowedTools?: string[];
  timeoutSeconds?: number;
}

export interface WorkflowInlineAgentRunState {
  id: string;
  title?: string;
  agent?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  executionMode?: 'plan' | 'read_only' | 'implement' | 'review';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  startedAt?: number;
  completedAt?: number;
  sessionId?: string;
  nativeSessionId?: string;
  worktreePath?: string;
  output?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}
