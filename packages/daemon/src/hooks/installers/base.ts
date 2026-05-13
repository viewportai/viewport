/**
 * HookInstaller interface — adapter-agnostic contract for installing hooks.
 *
 * Each agent adapter (Claude Code, Gemini, Cursor, etc.) has its own config
 * format and location. Installers abstract that away so `vpd install` can
 * install hooks for all detected agents uniformly.
 */

import type { HookEventKind } from '../types.js';

export interface HookInstallerConfig {
  /** The vpd binary path to use in hook commands. */
  vpdBinaryPath: string;
  /** The daemon listen target for hook HTTP calls. */
  daemonListen: string;
  /** Which hook events to install. */
  events: HookEventKind[];
}

export interface HookInstaller {
  /** Human-readable adapter name (e.g., 'Claude Code', 'Gemini CLI'). */
  readonly adapterName: string;

  /** Install hooks into the agent's configuration. Returns true if changed. */
  install(config: HookInstallerConfig): Promise<boolean>;

  /** Remove all Viewport hooks from the agent's configuration. Returns true if changed. */
  uninstall(): Promise<boolean>;

  /** Check if Viewport hooks are currently installed. */
  isInstalled(): Promise<boolean>;
}
