export interface WorkflowInlineAgentDefinition {
  title?: string;
  prompt: string;
  agent?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export interface WorkflowInlineAgentRunState {
  id: string;
  title?: string;
  agent?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  startedAt?: number;
  completedAt?: number;
  sessionId?: string;
  nativeSessionId?: string;
  worktreePath?: string;
  output?: string;
  error?: string;
}
