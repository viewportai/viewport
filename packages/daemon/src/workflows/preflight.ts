import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  WorkflowDefinition,
  WorkflowPreflightIssue,
  WorkflowPreflightResult,
} from './types.js';

const execFileAsync = promisify(execFile);
const SAFE_TOOL_NAME = /^[A-Za-z0-9._+/-]+$/;

export interface WorkflowCapabilityProvider {
  availableAgents: () => string[];
  directoryPath?: string;
}

export async function preflightWorkflow(
  definition: WorkflowDefinition,
  capabilities: WorkflowCapabilityProvider,
): Promise<WorkflowPreflightResult> {
  const issues: WorkflowPreflightIssue[] = [];
  const availableAgents = new Set(capabilities.availableAgents());

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
    if (node.type === 'approval') {
      issues.push({
        kind: 'node',
        name: nodeId,
        message: `Approval node ${nodeId} is reserved but not executable yet`,
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

async function hasShellTool(tool: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-lc', `command -v ${shellQuote(tool)}`], { timeout: 2_000 });
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
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}
