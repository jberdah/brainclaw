/**
 * Copy default agent profile YAML files from src to dist.
 * tsc only compiles .ts — this script ensures .yaml assets are included.
 */
import fs from 'node:fs';
import path from 'node:path';

const src = 'src/core/default-profiles';
const dst = 'dist/core/default-profiles';

fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src).filter(f => f.endsWith('.yaml'))) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
