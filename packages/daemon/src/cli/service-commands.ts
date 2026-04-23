import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configDir } from '../core/config.js';
import { getArgs } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';

type ServicePlatform = 'darwin' | 'linux';
type ServiceSubcommand = 'install' | 'uninstall' | 'status';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ServiceFiles {
  platform: ServicePlatform;
  label: string;
  filePath: string;
}

interface ServiceSpec {
  nodePath: string;
  daemonEntryPath: string;
  cwd: string;
  pathEnv: string;
  displayName: string;
}

export function resolveServiceWorkingDirectory(): string {
  return configDir();
}

export async function ensureServiceWorkingDirectory(): Promise<string> {
  const cwd = resolveServiceWorkingDirectory();
  await fs.mkdir(cwd, { recursive: true });
  return cwd;
}

function supportedPlatform(): ServicePlatform | null {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  return null;
}

export function currentServicePlatform(): ServicePlatform | null {
  return supportedPlatform();
}

function requireUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('Current platform does not expose process uid.');
  }
  return process.getuid();
}

function serviceFiles(platform: ServicePlatform): ServiceFiles {
  const home = os.homedir();
  if (platform === 'darwin') {
    return {
      platform,
      label: 'ai.viewport.daemon',
      filePath: path.join(home, 'Library', 'LaunchAgents', 'ai.viewport.daemon.plist'),
    };
  }
  return {
    platform,
    label: 'viewport-daemon.service',
    filePath: path.join(home, '.config', 'systemd', 'user', 'viewport-daemon.service'),
  };
}

function serviceSpec(): ServiceSpec {
  return {
    nodePath: process.execPath,
    daemonEntryPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.js'),
    cwd: resolveServiceWorkingDirectory(),
    pathEnv: process.env['PATH'] ?? '',
    displayName: 'ViewportAI Daemon',
  };
}

export function renderLaunchdPlist(label: string, spec: ServiceSpec): string {
  const esc = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const args = [spec.nodePath, spec.daemonEntryPath, 'start', '--foreground']
    .map((arg) => `    <string>${esc(arg)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${esc(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>WorkingDirectory</key>',
    `  <string>${esc(spec.cwd)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${esc(spec.pathEnv)}</string>`,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function renderSystemdUnit(serviceName: string, spec: ServiceSpec): string {
  const displayName = spec.displayName || 'ViewportAI Daemon';
  return [
    '[Unit]',
    `Description=${displayName}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${spec.cwd}`,
    `Environment=PATH=${spec.pathEnv}`,
    `ExecStart=${spec.nodePath} ${spec.daemonEntryPath} start --foreground`,
    'Restart=always',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
    `# ${serviceName}`,
  ].join('\n');
}

async function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export function resolveServiceSubcommand(args = getArgs()): ServiceSubcommand {
  if (args[0] === 'daemon' && args[1] === 'service') {
    const next = args[2] ?? 'status';
    if (next === 'install' || next === 'uninstall' || next === 'status') return next;
    throw new Error('Usage: vpd service <install|uninstall|status>');
  }
  const next = args[1] ?? 'status';
  if (next === 'install' || next === 'uninstall' || next === 'status') return next;
  throw new Error('Usage: vpd service <install|uninstall|status>');
}

async function installService(platform: ServicePlatform): Promise<Record<string, unknown>> {
  const files = serviceFiles(platform);
  const spec = serviceSpec();
  await ensureServiceWorkingDirectory();
  const content =
    platform === 'darwin'
      ? renderLaunchdPlist(files.label, spec)
      : renderSystemdUnit(files.label, spec);
  await fs.mkdir(path.dirname(files.filePath), { recursive: true });
  await fs.writeFile(files.filePath, content, 'utf-8');

  if (platform === 'darwin') {
    const uid = requireUid();
    await run('launchctl', ['bootout', `gui/${uid}/${files.label}`]).catch(() => undefined);
    const bootstrap = await run('launchctl', ['bootstrap', `gui/${uid}`, files.filePath]);
    if (bootstrap.code !== 0) {
      throw new Error(bootstrap.stderr || bootstrap.stdout || 'launchctl bootstrap failed');
    }
    const kickstart = await run('launchctl', ['kickstart', '-k', `gui/${uid}/${files.label}`]);
    if (kickstart.code !== 0) {
      throw new Error(kickstart.stderr || kickstart.stdout || 'launchctl kickstart failed');
    }
  } else {
    const reload = await run('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0)
      throw new Error(reload.stderr || reload.stdout || 'systemctl daemon-reload failed');
    const enable = await run('systemctl', ['--user', 'enable', '--now', files.label]);
    if (enable.code !== 0)
      throw new Error(enable.stderr || enable.stdout || 'systemctl enable failed');
  }

  return {
    command: 'service install',
    ok: true,
    platform,
    serviceFile: files.filePath,
    label: files.label,
  };
}

export async function installUserService(): Promise<Record<string, unknown>> {
  const platform = supportedPlatform();
  if (!platform) {
    throw new Error(`Unsupported platform: ${process.platform}. Supported: darwin, linux.`);
  }
  return installService(platform);
}

async function uninstallService(platform: ServicePlatform): Promise<Record<string, unknown>> {
  const files = serviceFiles(platform);
  if (platform === 'darwin') {
    const uid = requireUid();
    await run('launchctl', ['bootout', `gui/${uid}/${files.label}`]).catch(() => undefined);
  } else {
    await run('systemctl', ['--user', 'disable', '--now', files.label]).catch(() => undefined);
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  }
  await fs.rm(files.filePath, { force: true });
  return {
    command: 'service uninstall',
    ok: true,
    platform,
    serviceFile: files.filePath,
    label: files.label,
  };
}

export async function uninstallUserService(): Promise<Record<string, unknown>> {
  const platform = supportedPlatform();
  if (!platform) {
    throw new Error(`Unsupported platform: ${process.platform}. Supported: darwin, linux.`);
  }
  return uninstallService(platform);
}

async function statusService(platform: ServicePlatform): Promise<Record<string, unknown>> {
  const files = serviceFiles(platform);
  if (platform === 'darwin') {
    const uid = requireUid();
    const result = await run('launchctl', ['print', `gui/${uid}/${files.label}`]);
    return {
      command: 'service status',
      ok: result.code === 0,
      platform,
      active: result.code === 0,
      label: files.label,
      details: result.code === 0 ? result.stdout : result.stderr || result.stdout,
    };
  }

  const enabled = await run('systemctl', ['--user', 'is-enabled', files.label]);
  const active = await run('systemctl', ['--user', 'is-active', files.label]);
  return {
    command: 'service status',
    ok: true,
    platform,
    enabled: enabled.code === 0,
    active: active.code === 0,
    label: files.label,
    enabledState: enabled.stdout || enabled.stderr,
    activeState: active.stdout || active.stderr,
  };
}

export async function userServiceStatus(): Promise<Record<string, unknown>> {
  const platform = supportedPlatform();
  if (!platform) {
    return {
      command: 'service status',
      ok: false,
      active: false,
      error: `Unsupported platform: ${process.platform}. Supported: darwin, linux.`,
    };
  }
  return statusService(platform);
}

export async function service(): Promise<void> {
  const asJson = isJsonMode();
  const platform = supportedPlatform();
  if (!platform) {
    const payload = {
      command: 'service',
      ok: false,
      error: `Unsupported platform: ${process.platform}. Supported: darwin, linux.`,
    };
    if (asJson) {
      printJson(payload);
      return;
    }
    throw new Error(payload.error);
  }

  const subcommand = resolveServiceSubcommand();
  const payload =
    subcommand === 'install'
      ? await installService(platform)
      : subcommand === 'uninstall'
        ? await uninstallService(platform)
        : await statusService(platform);

  if (asJson) {
    printJson(payload);
    return;
  }

  if (subcommand === 'status') {
    const isActive = payload['active'] === true;
    console.log(
      `Service (${platform}) ${isActive ? 'is active' : 'is not active'}: ${String(payload['label'])}`,
    );
    return;
  }

  console.log(
    `${subcommand === 'install' ? 'Installed' : 'Uninstalled'} service (${platform}): ${String(payload['serviceFile'])}`,
  );
}
