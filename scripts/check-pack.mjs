import { spawnSync } from 'node:child_process';

const requiredPaths = [
  'LICENSE',
  'README.md',
  'dist/cli.js',
  'dist/facts.js',
  'dist/facts.json',
  'dist/brainclaw-vscode.vsix',
];
const requiredPrefixes = [
  'dist/core/default-profiles/',
  'docs/',
  // Code Map runtime assets: grammar WASM + curated query (.scm) trees. Without
  // these the published/packed code-map is bricked (the providers read .scm from
  // dist at runtime; there is no src/ fallback in an installed package). The
  // .scm presence is asserted explicitly below (a prefix match alone is satisfied
  // by the provider .js, which would hide a missing .scm).
  'dist/wasm/',
  'dist/core/code-map/lang/',
];
const forbiddenPrefixes = [
  '.github/',
  '.vscode/',
  'internal-docs/',
  'scripts/',
  'src/',
  'tests/',
  'vscode-extension/',
];
const forbiddenExactPaths = [
  'BRAINCLAW_VISION.md',
  'STANDARDIZATION_ANALYSIS.md',
  'tsconfig.json',
  'tsconfig.test.json',
];
const forbiddenSuffixes = [
  '.d.ts',
  '.d.ts.map',
  '.js.map',
  '.ts',
];

const command = process.platform === 'win32'
  ? (process.env.ComSpec?.trim() || 'cmd.exe')
  : 'npm';
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm', 'pack', '--json', '--dry-run', '--ignore-scripts']
  : ['pack', '--json', '--dry-run', '--ignore-scripts'];

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  encoding: 'utf-8',
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  const message = result.stderr.trim() || result.stdout.trim() || 'npm pack --dry-run failed';
  throw new Error(message);
}

const parsed = JSON.parse(result.stdout);
const pack = Array.isArray(parsed) ? parsed[0] : parsed;
const files = Array.isArray(pack?.files) ? pack.files : [];
const paths = files.map((file) => String(file.path));

const forbidden = paths.filter((path) =>
  forbiddenPrefixes.some((prefix) => path.startsWith(prefix))
  || forbiddenExactPaths.includes(path)
  || forbiddenSuffixes.some((suffix) => path.endsWith(suffix))
);
const missing = [
  ...requiredPaths.filter((path) => !paths.includes(path)),
  ...requiredPrefixes
    .filter((prefix) => !paths.some((path) => path.startsWith(prefix)))
    .map((prefix) => `${prefix}*`),
];

// Code Map brick guard: at least one curated query asset must be packed. A
// missing .scm passes every prefix check above (provider .js are present) but
// silently bricks code-map at runtime — so assert it directly.
if (!paths.some((path) => path.endsWith('.scm'))) {
  missing.push('dist/core/code-map/lang/**/*.scm (no .scm query assets packed — code-map would be bricked)');
}

if (forbidden.length > 0 || missing.length > 0) {
  if (forbidden.length > 0) {
    console.error('Forbidden paths detected in npm tarball:');
    forbidden.sort().forEach((path) => console.error(`- ${path}`));
  }
  if (missing.length > 0) {
    console.error('Required paths missing from npm tarball:');
    missing.forEach((path) => console.error(`- ${path}`));
  }
  process.exit(1);
}

console.log(`npm pack check passed: ${paths.length} file(s), ${pack.unpackedSize ?? 'unknown'} bytes unpacked.`);
