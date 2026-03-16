import type { AgentDefinition } from '../core/agent-registry.js';
import { claudeAgent } from './claude.js';
import { codexAgent } from './codex.js';
import { geminiAgent } from './gemini.js';

/** All built-in agent definitions shipped with the daemon. */
export const BUILT_IN_AGENTS: AgentDefinition[] = [claudeAgent, codexAgent, geminiAgent];
