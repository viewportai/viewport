import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  WorkflowDefinition,
  WorkflowPreflightIssue,
  WorkflowPreflightResult,
} from './types.js';
import type { ModelInfo } from '../core/agent-registry.js';

const execFileAsync = promisify(execFile);
const SAFE_TOOL_NAME = /^[A-Za-z0-9._+/-]+$/;
const TOOL_PREFLIGHT_TIMEOUT_MS = 5_000;

export interface WorkflowCapabilityProvider {
  availableAgents: () => string[];
  availableModels?: () => ModelInfo[] | Promise<ModelInfo[]>;
  directoryPath?: string;
}

export async function preflightWorkflow(
  definition: WorkflowDefinition,
  capabilities: WorkflowCapabilityProvider,
): Promise<WorkflowPreflightResult> {
  const issues: WorkflowPreflightIssue[] = [];
  const availableAgents = new Set(capabilities.availableAgents());
  const availableModels = capabilities.availableModels ? await capabilities.availableModels() : [];

  for (const agent of definition.requires?.agents ?? []) {
    if (!availableAgents.has(agent)) {
      issues.push({
        kind: 'agent',
        name: agent,
        message: `Required agent is unavailable: ${agent}`,
      });
    }
  }

  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    if (node.type === 'prompt' && node.agent && !availableAgents.has(node.agent)) {
      issues.push({
        kind: 'agent',
        name: node.agent,
        message: `Node ${nodeId} requires unavailable agent: ${node.agent}`,
      });
    }
    if (node.type === 'prompt') {
      addModelIssue(issues, availableModels, {
        nodeId,
        agent: node.agent,
        model: node.model,
        label: `Node ${nodeId}`,
      });
      for (const [agentId, inlineAgent] of Object.entries(node.agents ?? {})) {
        const requiredAgent = inlineAgent.agent ?? node.agent;
        if (requiredAgent && !availableAgents.has(requiredAgent)) {
          issues.push({
            kind: 'agent',
            name: requiredAgent,
            message: `Inline agent ${agentId} on node ${nodeId} requires unavailable agent: ${requiredAgent}`,
          });
        }
        addModelIssue(issues, availableModels, {
          nodeId,
          agent: requiredAgent,
          model: inlineAgent.model ?? node.model,
          label: `Inline agent ${agentId} on node ${nodeId}`,
        });
      }
    }

    if (node.type === 'loop' && node.body.type === 'prompt') {
      if (node.body.agent && !availableAgents.has(node.body.agent)) {
        issues.push({
          kind: 'agent',
          name: node.body.agent,
          message: `Loop body on node ${nodeId} requires unavailable agent: ${node.body.agent}`,
        });
      }
      addModelIssue(issues, availableModels, {
        nodeId,
        agent: node.body.agent,
        model: node.body.model,
        label: `Loop body on node ${nodeId}`,
      });
    }

    if (
      node.type === 'approval' &&
      'onReject' in node &&
      node.onReject &&
      'prompt' in node.onReject
    ) {
      if (node.onReject.agent && !availableAgents.has(node.onReject.agent)) {
        issues.push({
          kind: 'agent',
          name: node.onReject.agent,
          message: `Rejection prompt on node ${nodeId} requires unavailable agent: ${node.onReject.agent}`,
        });
      }
      addModelIssue(issues, availableModels, {
        nodeId,
        agent: node.onReject.agent,
        model: node.onReject.model,
        label: `Rejection prompt on node ${nodeId}`,
      });
    }
  }

  for (const tool of definition.requires?.tools ?? []) {
    if (!SAFE_TOOL_NAME.test(tool) || !(await hasShellTool(tool))) {
      issues.push({
        kind: 'tool',
        name: tool,
        message: `Required shell tool is unavailable: ${tool}`,
      });
    }
  }

  if (definition.requires?.tools?.includes('git') && capabilities.directoryPath) {
    if (!(await isGitWorkTree(capabilities.directoryPath))) {
      issues.push({
        kind: 'tool',
        name: 'git',
        message: `Selected directory is not a git repository: ${capabilities.directoryPath}`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

function addModelIssue(
  issues: WorkflowPreflightIssue[],
  availableModels: ModelInfo[],
  target: { nodeId: string; agent?: string; model?: string; label: string },
): void {
  if (!target.model || availableModels.length === 0) return;

  const isAvailable = availableModels.some((model) => {
    if (model.value !== target.model) return false;
    return !target.agent || !model.agentId || model.agentId === target.agent;
  });

  if (isAvailable) return;

  const agentSuffix = target.agent ? ` for agent ${target.agent}` : '';
  issues.push({
    kind: 'node',
    name: target.nodeId,
    message: `${target.label} requests unavailable model${agentSuffix}: ${target.model}`,
  });
}

async function hasShellTool(tool: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-lc', `command -v ${shellQuote(tool)}`], {
      timeout: TOOL_PREFLIGHT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function isGitWorkTree(directoryPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', directoryPath, 'rev-parse', '--is-inside-work-tree'], {
      timeout: TOOL_PREFLIGHT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}
