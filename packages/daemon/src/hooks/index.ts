/**
 * Hooks module — barrel export.
 */

export { HookRouter } from './router.js';
export { SupervisionManager } from './supervision.js';
export { ClaudeHookInstaller } from './installers/claude.js';
export type { HookInstaller, HookInstallerConfig } from './installers/base.js';
export type { HookEventKind, HookEventDefinition, HookResponse, HookBaseInput } from './types.js';
export { HOOK_EVENT_KINDS, DEFAULT_EVENT_DEFINITIONS, HOOK_INPUT_SCHEMAS } from './types.js';
