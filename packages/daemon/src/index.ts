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
 */

import { ensureLocalTlsTrust } from './cli/local-tls.js';

// Must run before any TLS connections are made in this process.
ensureLocalTlsTrust();

import { getCommand, getArgs } from './cli/args.js';
import {
  install,
  addDirectory,
  removeDirectory,
  list,
  status,
  stop,
  restart,
  run,
  send,
  logs,
  wait,
  attach,
  pair,
  update,
  showHelp,
  ls,
  stopSession,
  permit,
  agent,
  worktree,
  service,
  setup,
  remote,
} from './cli/commands.js';
import { hookNotify } from './cli/hook-command.js';
import { start, runSupervisorCommand, runWorkerCommand } from './startup.js';

const commands: Record<string, () => Promise<void>> = {
  start,
  install,
  add: addDirectory,
  remove: removeDirectory,
  list,
  status,
  stop,
  restart,
  run,
  send,
  logs,
  wait,
  attach,
  pair,
  update,
  ls,
  permit,
  agent,
  worktree,
  service,
  setup,
  remote,
};

const command = getCommand();

// Sub-command: vpd hook notify --event <EventName>
if (command === 'hook') {
  const subcommand = getArgs()[1];
  if (subcommand === 'notify') {
    hookNotify().catch(() => process.exit(1));
  } else {
    console.error(`Unknown hook subcommand: ${subcommand}`);
    console.error('Usage: vpd hook notify --event <EventName>');
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
      const subcommand = getArgs()[1] ?? 'status';
      if (subcommand === 'start') handler = start;
      if (subcommand === 'status') handler = status;
      if (subcommand === 'stop') handler = stop;
      if (subcommand === 'restart') handler = restart;
      if (subcommand === 'pair') handler = pair;
      if (subcommand === 'update') handler = update;
      if (subcommand === 'service') handler = service;
      if (subcommand === 'setup') handler = setup;
    } else if (command === 'session') {
      const subcommand = getArgs()[1];
      if (subcommand === 'stop') handler = stopSession;
    } else if (command === 'permit') {
      handler = permit;
    } else if (command === 'agent') {
      handler = agent;
    } else if (command === 'worktree') {
      handler = worktree;
    } else if (command === 'remote') {
      handler = remote;
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
