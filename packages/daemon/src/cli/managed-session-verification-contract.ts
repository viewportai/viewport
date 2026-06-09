export interface ManagedSessionVerificationContract {
  schema?: string | null;
  agent_session_id?: string | null;
  agentSessionId?: string | null;
  workspace_id?: string | null;
  workspaceId?: string | null;
  workflow_run_id?: string | null;
  workflowRunId?: string | null;
  status?: string | null;
  commands?: ManagedSessionVerificationCommand[] | null;
  required_artifacts?: string[] | null;
  requiredArtifacts?: string[] | null;
  repair_policy?: Record<string, unknown> | null;
  repairPolicy?: Record<string, unknown> | null;
  review_policy?: Record<string, unknown> | null;
  reviewPolicy?: Record<string, unknown> | null;
  runtime_tool?: ManagedSessionVerificationRuntimeTool | null;
  runtimeTool?: ManagedSessionVerificationRuntimeTool | null;
  access_model?: ManagedSessionVerificationAccessModel | null;
  accessModel?: ManagedSessionVerificationAccessModel | null;
  [key: string]: unknown;
}

export interface ManagedSessionVerificationCommand {
  schema?: string | null;
  name?: string | null;
  command?: string | null;
  required?: boolean | null;
  timeout?: string | null;
  working_directory?: string | null;
  workingDirectory?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

export interface ManagedSessionVerificationRuntimeTool {
  name?: string | null;
  runtime_endpoint?: string | null;
  runtimeEndpoint?: string | null;
  method?: string | null;
  [key: string]: unknown;
}

export interface ManagedSessionVerificationAccessModel {
  runner_may_execute_commands?: boolean | null;
  runnerMayExecuteCommands?: boolean | null;
  [key: string]: unknown;
}
