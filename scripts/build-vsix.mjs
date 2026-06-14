/**
 * Build the optional VS Code extension .vsix and copy it into dist/.
 *
 * Default mode is release-strict: missing extension dependencies or packaging
 * failures fail the command because package.json declares the VSIX in the npm
 * tarball. Pass --optional for local CLI builds where VS Code support is not
 * required.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const extDir = join(root, 'vscode-extension');
const optional = process.argv.includes('--optional');
// Read the current extension version from its package.json so rebuilds pick
// up bumps automatically. Previously this was hardcoded to 0.1.0, which made
// `dist/brainclaw-vscode.vsix` stale by silently copying the oldest build on
// disk every time the npm build ran.
const extPkg = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf-8'));
const outVsix = join(extDir, `brainclaw-vscode-${extPkg.version}.vsix`);
const destDir = join(root, 'dist');
const destVsix = join(destDir, 'brainclaw-vscode.vsix');

// Skip gracefully only for local optional builds. Release builds must be
// deterministic: CI/prepublish install vscode-extension dependencies first.
const hasVscodeDeps = existsSync(join(extDir, 'node_modules', '@types', 'vscode'));
if (!hasVscodeDeps) {
  const message = 'vscode-extension/node_modules not installed. Run `npm ci --prefix vscode-extension` before release builds.';
  if (optional) {
    console.log(`⚠ Skipping optional vsix build — ${message}`);
    process.exit(0);
  }
  console.error(`Error: ${message}`);
  process.exit(1);
}

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
