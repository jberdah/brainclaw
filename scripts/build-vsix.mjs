/**
 * Build the VS Code extension .vsix and copy it into dist/ for npm distribution.
 * Requires: vscode-extension/ to have been compiled (tsc) already.
 * Uses @vscode/vsce programmatically to avoid global install dependency.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const extDir = join(root, 'vscode-extension');
const outVsix = join(extDir, 'brainclaw-vscode-0.1.0.vsix');
const destDir = join(root, 'dist');
const destVsix = join(destDir, 'brainclaw-vscode.vsix');

// 1. Compile extension TypeScript
console.log('→ Compiling vscode-extension...');
execSync('npx tsc -p tsconfig.json', { cwd: extDir, stdio: 'inherit' });

// 2. Package vsix
console.log('→ Packaging vsix...');
execSync('npx @vscode/vsce package --allow-missing-repository', { cwd: extDir, stdio: 'inherit' });

if (!existsSync(outVsix)) {
  console.error('Error: vsix not found at', outVsix);
  process.exit(1);
}

// 3. Copy to dist/
if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
cpSync(outVsix, destVsix);
console.log(`✔ Copied to dist/brainclaw-vscode.vsix`);
