/**
 * CLI command surface.
 *
 * Commands are split by concern to keep modules focused:
 * - install
 * - directory management
 * - daemon lifecycle
 * - orchestration
 */

export { install } from './install-command.js';
export { addDirectory, removeDirectory, list } from './directory-commands.js';
export {
  status,
  doctor,
  stop,
  restart,
  pair,
  update,
  showDaemonHelp,
  showHelp,
} from './lifecycle-commands.js';
export {
  runSession as run,
  sendPromptCommand as send,
  logsCommand as logs,
  waitCommand as wait,
  attachCommand as attach,
} from './orchestration-commands.js';
export {
  listSessions as ls,
  showSessionHelp,
  stopSession,
  sessionManifest,
} from './session-commands.js';
export { permit } from './permission-commands.js';
export { agent } from './agent-commands.js';
export { worktree } from './worktree-commands.js';
export { workflow } from './workflow-commands.js';
export { context } from './context-command.js';
export { config, contract, validate } from './resource-config-command.js';
export { guard } from './guard-command.js';
export { skills } from './skills-command.js';
export { service } from './service-commands.js';
export { setup } from './setup-command.js';
export { remote } from './remote-commands.js';
export { profile, useProfileAlias as use } from './profile-command.js';
export { uninstall } from './uninstall-command.js';
export { bind } from './bind-command.js';
export { unlock } from './unlock-command.js';
