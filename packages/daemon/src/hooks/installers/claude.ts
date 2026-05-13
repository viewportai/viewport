/**
 * Claude Code hook installer — merges Viewport hooks into ~/.claude/settings.json.
 *
 * Claude Code reads hooks from the global settings file on session start.
 * This installer adds/updates Viewport hook entries without disturbing
 * any user-configured hooks.
 *
 * Hook entries are tagged with a marker comment in the command so we can
 * identify and update them on reinstall or remove them on uninstall.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { HookInstaller, HookInstallerConfig } from './base.js';
import { CLAUDE_HOOK_EVENT_KINDS, type HookEventKind } from '../types.js';

const VIEWPORT_MARKER = '--viewport-hook';

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildVpdCommand(vpdPath: string): string {
  if (vpdPath.startsWith('npx tsx ')) {
    return `npx tsx ${shellQuote(vpdPath.slice('npx tsx '.length))}`;
  }

  return shellQuote(vpdPath);
}

/** Build the hook command string for a given event. */
function buildCommand(vpdPath: string, listen: string, event: string): string {
  const cmd = buildVpdCommand(vpdPath);
  return `${cmd} hook notify --event ${event} --listen ${shellQuote(listen)} ${VIEWPORT_MARKER}`;
}

/** Determine the timeout for a hook event. */
function timeoutForEvent(event: string): number {
  // PermissionRequest blocks waiting for supervisor response — long timeout
  if (event === 'PermissionRequest') return 120;
  return 5;
}

export class ClaudeHookInstaller implements HookInstaller {
  readonly adapterName = 'Claude Code';

  async install(config: HookInstallerConfig): Promise<boolean> {
    const filePath = settingsPath();
    const settings = await readSettings(filePath);

    const hooks = (settings.hooks ?? {}) as Record<
      string,
      Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>
    >;
    settings.hooks = hooks;

    const before = JSON.stringify(settings);

    for (const [event, entries] of Object.entries(hooks)) {
      const filtered = removeViewportHookEntries(entries);
      if (filtered.length !== entries.length) {
        if (filtered.length === 0) {
          delete hooks[event];
        } else {
          hooks[event] = filtered;
        }
      }
    }

    for (const event of config.events.filter(isClaudeHookEventKind)) {
      const hookEntry = {
        type: 'command' as const,
        command: buildCommand(config.vpdBinaryPath, config.daemonListen, event),
        timeout: timeoutForEvent(event),
      };

      const existing = hooks[event] ?? [];
      const filtered = removeViewportHookEntries(existing);

      filtered.push({ hooks: [hookEntry] });

      if (JSON.stringify(filtered) !== JSON.stringify(existing)) {
        hooks[event] = filtered;
      }
    }

    const changed = JSON.stringify(settings) !== before;
    if (changed) {
      await writeSettings(filePath, settings);
    }
    return changed;
  }

  async uninstall(): Promise<boolean> {
    const filePath = settingsPath();

    let settings: Record<string, unknown>;
    try {
      settings = await readSettings(filePath);
    } catch {
      return false; // No settings file — nothing to uninstall
    }

    const hooks = settings.hooks as Record<
      string,
      Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>
    >;
    if (!hooks) return false;

    let changed = false;

    for (const [event, entries] of Object.entries(hooks)) {
      const filtered = removeViewportHookEntries(entries);

      if (filtered.length !== entries.length) {
        if (filtered.length === 0) {
          delete hooks[event];
        } else {
          hooks[event] = filtered;
        }
        changed = true;
      }
    }

    if (changed) {
      await writeSettings(filePath, settings);
    }
    return changed;
  }

  async isInstalled(): Promise<boolean> {
    try {
      const settings = await readSettings(settingsPath());
      const hooks = settings.hooks as Record<
        string,
        Array<{ hooks: Array<Record<string, unknown>> }>
      >;
      if (!hooks) return false;

      return Object.values(hooks).some((entries) =>
        entries.some((entry) =>
          entry.hooks?.some(
            (h) => typeof h.command === 'string' && h.command.includes(VIEWPORT_MARKER),
          ),
        ),
      );
    } catch {
      return false;
    }
  }
}

function isClaudeHookEventKind(
  event: HookEventKind,
): event is (typeof CLAUDE_HOOK_EVENT_KINDS)[number] {
  return (CLAUDE_HOOK_EVENT_KINDS as readonly HookEventKind[]).includes(event);
}

function removeViewportHookEntries(
  entries: Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>,
): Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }> {
  return entries.filter(
    (entry) =>
      !entry.hooks?.some((h: Record<string, unknown>) => isViewportHookHandler(h)),
  );
}

function isViewportHookHandler(hook: Record<string, unknown>): boolean {
  if (typeof hook.command === 'string' && hook.command.includes(VIEWPORT_MARKER)) {
    return true;
  }

  if (
    Array.isArray(hook.args) &&
    hook.args.some((arg) => typeof arg === 'string' && arg === VIEWPORT_MARKER)
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Settings file I/O
// ---------------------------------------------------------------------------

async function readSettings(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeSettings(filePath: string, settings: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}
