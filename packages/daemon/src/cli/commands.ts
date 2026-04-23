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
export { status, doctor, stop, restart, pair, update, showHelp } from './lifecycle-commands.js';
export {
  runSession as run,
  sendPromptCommand as send,
  logsCommand as logs,
  waitCommand as wait,
  attachCommand as attach,
} from './orchestration-commands.js';
export { listSessions as ls, stopSession } from './session-commands.js';
export { permit } from './permission-commands.js';
export { agent } from './agent-commands.js';
export { worktree } from './worktree-commands.js';
export { service } from './service-commands.js';
export { setup } from './setup-command.js';
export { remote } from './remote-commands.js';
