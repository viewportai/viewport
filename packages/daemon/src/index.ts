#!/usr/bin/env node

/**
 * Viewport Daemon — CLI entry point.
 *
 * Commands:
 *   vpd start [--port 7070]   Start the daemon
 *   vpd install               Detect available agents
 *   vpd add <path>            Register a directory
 *   vpd remove <path>         Unregister a directory
 *   vpd list                  List directories + active sessions
 *   vpd status                Daemon health check
 *   vpd stop                  Stop the daemon
 *   vpd restart               Restart the daemon
 *   vpd worktree ...          Worktree operator commands
 *   vpd validate              Validate repo-local Viewport contracts
 *   vpd contract ...          Resolve repo-local Viewport contracts
 *   vpd guard ...             Check repo-local approval/risk gates
 *   vpd config ...            Resolve repo-local Viewport resources
 *   vpd context ...           Local trusted-edge context commands
 *   vpd unlock <id>           Activate a short-lived hosted-web trusted-edge session
 *   vpd skills ...            Install agent skills that call vpd
 */

import { getCommand, getArgs } from './cli/args.js';
import { resolveGlobalFlag } from './cli/global-flags.js';
import {
  install,
  addDirectory,
  removeDirectory,
  list,
  status,
  doctor,
  stop,
  restart,
  run,
  send,
  logs,
  wait,
  attach,
  pair,
  update,
  showDaemonHelp,
  showHelp,
  ls,
  showSessionHelp,
  stopSession,
  sessionManifest,
  permit,
  agent,
  worktree,
  workflow,
  config,
  contract,
  validate,
  guard,
  context,
  skills,
  service,
  setup,
  remote,
  profile,
  use,
  uninstall,
  bind,
  unlock,
} from './cli/commands.js';
import { resolveDisplayVersion } from './core/package-meta.js';
import { hookCapabilities, hookNotify, showHookHelp } from './cli/hook-command.js';
import { start, runSupervisorCommand, runWorkerCommand } from './startup.js';
import { SUPERVISOR_CONFIG_ENV, WORKER_CONFIG_ENV } from './cli/supervisor-protocol.js';

const rawArgs = getArgs();
const globalFlag = resolveGlobalFlag(rawArgs);

if (globalFlag === 'help') {
  showHelp();
  process.exit(0);
}

if (globalFlag === 'version') {
  console.log(resolveDisplayVersion());
  process.exit(0);
}

const commands: Record<string, () => Promise<void>> = {
  start,
  install,
  add: addDirectory,
  remove: removeDirectory,
  list,
  status,
  doctor,
  stop,
  restart,
  run,
  send,
  logs,
  wait,
  attach,
  pair,
  update,
  upgrade: update,
  ls,
  permit,
  agent,
  worktree,
  workflow,
  config,
  contract,
  validate,
  guard,
  context,
  skills,
  service,
  setup,
  remote,
  profile,
  use,
  uninstall,
  bind,
  unlock,
};

const command = getCommand();

if (command !== '__supervisor' && command !== '__worker') {
  delete process.env[SUPERVISOR_CONFIG_ENV];
  delete process.env[WORKER_CONFIG_ENV];
}

// Sub-command: vpd hook notify --event <EventName>
if (command === 'hook') {
  const subcommand = getArgs()[1];
  if (!subcommand) {
    showHookHelp();
    process.exit(0);
  } else if (subcommand === 'notify') {
    hookNotify().catch(() => process.exit(1));
  } else if (subcommand === 'plan' || subcommand === 'plan-proposed') {
    hookNotify('PlanProposed').catch(() => process.exit(1));
  } else if (subcommand === 'capabilities') {
    hookCapabilities().catch(() => process.exit(1));
  } else {
    console.error(`Unknown hook subcommand: ${subcommand}`);
    console.error('Usage: vpd hook notify --event <EventName>');
    console.error('       vpd hook plan < hook-payload.json');
    console.error('       vpd hook capabilities [--adapter <name>] [--json]');
    process.exit(1);
  }
} else {
  if (command === '__supervisor') {
    runSupervisorCommand().catch((err: Error) => {
      console.error(`Supervisor error: ${err.message}`);
      process.exit(1);
    });
  } else if (command === '__worker') {
    runWorkerCommand().catch((err: Error) => {
      console.error(`Worker error: ${err.message}`);
      process.exit(1);
    });
  } else {
    let handler = commands[command];
    if (command === 'daemon') {
      const subcommand = getArgs()[1];
      if (!subcommand) {
        showDaemonHelp();
        process.exit(0);
      }
      if (subcommand === 'start') handler = start;
      if (subcommand === 'doctor') handler = doctor;
      if (subcommand === 'status') handler = status;
      if (subcommand === 'stop') handler = stop;
      if (subcommand === 'restart') handler = restart;
      if (subcommand === 'pair') handler = pair;
      if (subcommand === 'update') handler = update;
      if (subcommand === 'service') handler = service;
      if (subcommand === 'setup') handler = setup;
    } else if (command === 'session') {
      const subcommand = getArgs()[1];
      if (!subcommand) {
        showSessionHelp();
        process.exit(0);
      }
      if (subcommand === 'stop') handler = stopSession;
      if (subcommand === 'manifest') handler = sessionManifest;
    } else if (command === 'permit') {
      handler = permit;
    } else if (command === 'agent') {
      handler = agent;
    } else if (command === 'worktree') {
      handler = worktree;
    } else if (command === 'workflow') {
      handler = workflow;
    } else if (command === 'config') {
      handler = config;
    } else if (command === 'contract') {
      handler = contract;
    } else if (command === 'guard') {
      handler = guard;
    } else if (command === 'context') {
      handler = context;
    } else if (command === 'skills') {
      handler = skills;
    } else if (command === 'remote') {
      handler = remote;
    } else if (command === 'bind') {
      handler = bind;
    }
    if (!handler) {
      if (command !== 'help') {
        console.error(`Unknown command: ${command}\n`);
      }
      showHelp();
      process.exit(command === 'help' ? 0 : 1);
    }

    handler().catch((err: Error) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
  }
}
