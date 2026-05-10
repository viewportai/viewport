import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import {
  VIEWPORT_CONFIG_FILE,
  VIEWPORT_CONFIG_FILES,
  type SessionResourceWarning,
} from './types.js';
import YAML from 'yaml';

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build']);

export async function discoverViewportConfigPaths(options: {
  workingDirectory: string;
  explicitConfigPaths?: string[];
  maxChildConfigs?: number;
}): Promise<{ configPaths: string[]; warnings: SessionResourceWarning[] }> {
  if (options.explicitConfigPaths && options.explicitConfigPaths.length > 0) {
    return {
      configPaths: uniqueSorted(
        options.explicitConfigPaths.map((configPath) => path.resolve(configPath)),
      ),
      warnings: [],
    };
  }

  const workingDirectory = path.resolve(options.workingDirectory);
  const nearest = await findNearestConfig(workingDirectory);
  if (nearest && (await isResourceConfigFile(nearest))) {
    return { configPaths: [nearest], warnings: [] };
  }

  const childConfigs = await findChildRepoConfigs(workingDirectory, options.maxChildConfigs ?? 5);
  return buildDiscoveryResult(childConfigs, options.maxChildConfigs ?? 5);
}

export function discoverViewportConfigPathsSync(options: {
  workingDirectory: string;
  explicitConfigPaths?: string[];
  maxChildConfigs?: number;
}): { configPaths: string[]; warnings: SessionResourceWarning[] } {
  if (options.explicitConfigPaths && options.explicitConfigPaths.length > 0) {
    return {
      configPaths: uniqueSorted(
        options.explicitConfigPaths.map((configPath) => path.resolve(configPath)),
      ),
      warnings: [],
    };
  }

  const workingDirectory = path.resolve(options.workingDirectory);
  const nearest = findNearestConfigSync(workingDirectory);
  if (nearest && isResourceConfigFileSync(nearest)) {
    return { configPaths: [nearest], warnings: [] };
  }

  const childConfigs = findChildRepoConfigsSync(workingDirectory, options.maxChildConfigs ?? 5);
  return buildDiscoveryResult(childConfigs, options.maxChildConfigs ?? 5);
}

function buildDiscoveryResult(
  childConfigs: { configPaths: string[]; tooMany: boolean },
  maxChildConfigs: number,
): { configPaths: string[]; warnings: SessionResourceWarning[] } {
  if (childConfigs.tooMany) {
    return {
      configPaths: childConfigs.configPaths,
      warnings: [
        {
          code: 'too_many_configs_found',
          message: `Found more than ${maxChildConfigs} child Viewport configs; using the first bounded set and requiring explicit selection for the rest.`,
        },
      ],
    };
  }

  if (childConfigs.configPaths.length > 1) {
    return {
      configPaths: childConfigs.configPaths,
      warnings: [
        {
          code: 'multiple_configs_found',
          message: `Found ${childConfigs.configPaths.length} child Viewport configs; additive resources will be merged.`,
        },
      ],
    };
  }

  if (childConfigs.configPaths.length === 1) {
    return { configPaths: childConfigs.configPaths, warnings: [] };
  }

  return {
    configPaths: [],
    warnings: [
      {
        code: 'no_config_found',
        message: `No ${VIEWPORT_CONFIG_FILE} found.`,
      },
    ],
  };
}

async function findNearestConfig(startDirectory: string): Promise<string | null> {
  let current = path.resolve(startDirectory);
  for (;;) {
    for (const configFile of VIEWPORT_CONFIG_FILES) {
      const candidate = path.join(current, configFile);
      if (await exists(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findNearestConfigSync(startDirectory: string): string | null {
  let current = path.resolve(startDirectory);
  for (;;) {
    for (const configFile of VIEWPORT_CONFIG_FILES) {
      const candidate = path.join(current, configFile);
      if (fsSync.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function findChildRepoConfigs(
  startDirectory: string,
  maxChildConfigs: number,
): Promise<{ configPaths: string[]; tooMany: boolean }> {
  const children = await safeReaddir(startDirectory);
  const configPaths: string[] = [];
  let tooMany = false;

  for (const child of children) {
    if (DEFAULT_EXCLUDES.has(child.name)) continue;
    if (!child.isDirectory()) continue;
    const candidate = await firstExistingConfig(path.join(startDirectory, child.name));
    if (candidate && (await isResourceConfigFile(candidate))) {
      configPaths.push(candidate);
      if (configPaths.length > maxChildConfigs) {
        tooMany = true;
        break;
      }
    }
  }

  return {
    configPaths: uniqueSorted(configPaths.slice(0, maxChildConfigs)),
    tooMany,
  };
}

function findChildRepoConfigsSync(
  startDirectory: string,
  maxChildConfigs: number,
): { configPaths: string[]; tooMany: boolean } {
  const children = safeReaddirSync(startDirectory);
  const configPaths: string[] = [];
  let tooMany = false;

  for (const child of children) {
    if (DEFAULT_EXCLUDES.has(child.name)) continue;
    if (!child.isDirectory()) continue;
    const candidate = firstExistingConfigSync(path.join(startDirectory, child.name));
    if (candidate && isResourceConfigFileSync(candidate)) {
      configPaths.push(candidate);
      if (configPaths.length > maxChildConfigs) {
        tooMany = true;
        break;
      }
    }
  }

  return {
    configPaths: uniqueSorted(configPaths.slice(0, maxChildConfigs)),
    tooMany,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingConfig(directoryPath: string): Promise<string | null> {
  for (const configFile of VIEWPORT_CONFIG_FILES) {
    const candidate = path.join(directoryPath, configFile);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function firstExistingConfigSync(directoryPath: string): string | null {
  for (const configFile of VIEWPORT_CONFIG_FILES) {
    const candidate = path.join(directoryPath, configFile);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return null;
}

async function safeReaddir(directoryPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReaddirSync(directoryPath: string): Dirent[] {
  try {
    return fsSync.readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function isResourceConfigFile(configPath: string): Promise<boolean> {
  try {
    return hasResourceConfigShape(parseConfig(await fs.readFile(configPath, 'utf8'), configPath));
  } catch {
    return true;
  }
}

function isResourceConfigFileSync(configPath: string): boolean {
  try {
    return hasResourceConfigShape(parseConfig(fsSync.readFileSync(configPath, 'utf8'), configPath));
  } catch {
    return true;
  }
}

function hasResourceConfigShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  return Boolean(
    object.resources ||
    object.context ||
    object.workflows ||
    object.approvals ||
    object.defaults ||
    object.scope ||
    object.name ||
    object.$schema,
  );
}

function parseConfig(raw: string, configPath: string): unknown {
  if (configPath.endsWith('.json')) return JSON.parse(raw);
  return YAML.parse(raw);
}
