import fs from 'node:fs';
import path from 'node:path';

const files = ['.env', '.env.local'];
const loaded = new Set();

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const equals = trimmed.indexOf('=');
  if (equals <= 0) return null;
  const key = trimmed.slice(0, equals).trim();
  const value = unquote(trimmed.slice(equals + 1));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return [key, value];
}

for (const file of files) {
  const fullPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) continue;
  const content = fs.readFileSync(fullPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const pair = parseLine(line);
    if (!pair) continue;
    const [key, value] = pair;
    if (loaded.has(key) || process.env[key] === undefined) {
      process.env[key] = value;
      loaded.add(key);
    }
  }
}
