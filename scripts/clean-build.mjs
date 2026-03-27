import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = process.argv.slice(2);
const selected = targets.length > 0 ? targets : ['dist', 'dist-test'];

for (const relativeDir of selected) {
  fs.rmSync(path.join(rootDir, relativeDir), { recursive: true, force: true });
}
