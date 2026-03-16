import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distEntry = path.join(process.cwd(), 'dist', 'index.js');
if (!fs.existsSync(distEntry)) {
  console.error('[relay] dist/index.js not found. Run `npm run build` first.');
  process.exit(1);
}

await import(pathToFileURL(distEntry).href);
