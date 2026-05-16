import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CONTRACTS, contractBySampleFile, type ContractDefinition } from './contracts.js';

export interface ProtocolSample {
  readonly contract: ContractDefinition;
  readonly fileName: string;
  readonly path: string;
  readonly text: string;
  readonly document: unknown;
}

export function samplesDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples');
}

export function sampleFiles(): string[] {
  return CONTRACTS.map((contract) => contract.sampleFile);
}

export async function readSample(fileName: string): Promise<ProtocolSample> {
  const contract = contractBySampleFile(fileName);
  if (!contract) {
    throw new Error(`Unknown protocol sample: ${fileName}`);
  }

  const samplePath = path.join(samplesDirectory(), fileName);
  const text = await fs.readFile(samplePath, 'utf8');
  return {
    contract,
    fileName,
    path: samplePath,
    text,
    document: YAML.parse(text),
  };
}

export async function readAllSamples(): Promise<ProtocolSample[]> {
  return Promise.all(sampleFiles().map((fileName) => readSample(fileName)));
}
