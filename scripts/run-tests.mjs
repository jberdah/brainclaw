import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distTestsDir = path.join(rootDir, 'dist-test', 'tests');

const groupName = process.argv[2] ?? 'default';

function toPlatformPath(value) {
  if (process.platform !== 'win32') {
    return value;
  }
  return value.replace(/^\/([A-Za-z]:\/)/, '$1').replace(/\//g, '\\');
}

function walk(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function relativeTestPath(filepath) {
  return path.relative(rootDir, filepath);
}

const allTests = walk(distTestsDir);
const unitTests = walk(path.join(distTestsDir, 'unit'));
const smokeTests = allTests.filter((filepath) => filepath.endsWith(`${path.sep}smoke.test.js`));
const e2eTests = allTests.filter((filepath) => !unitTests.includes(filepath) && !smokeTests.includes(filepath));

const groups = {
  default: [...unitTests, ...smokeTests],
  unit: unitTests,
  smoke: smokeTests,
  e2e: e2eTests,
  all: [...unitTests, ...smokeTests, ...e2eTests],
};

const selected = groups[groupName];

if (!selected) {
  console.error(`Unknown test group "${groupName}". Expected one of: ${Object.keys(groups).join(', ')}`);
  process.exit(1);
}

if (selected.length === 0) {
  console.error(`No tests found for group "${groupName}".`);
  process.exit(1);
}

// Per-file timeouts: some CLI-heavy unit files legitimately take >60s on Windows.
const perFileTimeoutMs = {
  default: 180000,
  unit: 180000,
  smoke: 60000,
  e2e: 180000,
  all: 600000,
};

const timeoutMs = perFileTimeoutMs[groupName];
const startedAt = Date.now();

console.log(`Running ${selected.length} ${groupName} test file(s) sequentially (${timeoutMs / 1000}s per file)`);

const failures = [];

for (const testFile of selected) {
  const label = relativeTestPath(testFile);
  const fileStartedAt = Date.now();
  console.log(`\n==> ${label}`);

  const result = spawnSync(process.execPath, ['--test', toPlatformPath(testFile)], {
    cwd: rootDir,
    stdio: 'inherit',
    timeout: timeoutMs,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: process.env.BRAINCLAW_SKIP_SETUP_REQUIREMENT ?? '1',
    },
  });

  const durationMs = Date.now() - fileStartedAt;
  if (result.error) {
    console.error(`Test runner error in ${label} after ${durationMs}ms`);
    console.error(result.error.code === 'ETIMEDOUT' ? `  TIMEOUT after ${timeoutMs}ms` : result.error);
    failures.push({ label, reason: result.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'ERROR', durationMs });
    continue;
  }
  if (result.status !== 0) {
    console.error(`Test file failed: ${label} (${durationMs}ms)`);
    failures.push({ label, reason: 'FAIL', durationMs });
    continue;
  }

  console.log(`<== ok ${label} (${durationMs}ms)`);
}

const totalMs = Date.now() - startedAt;
console.log(`\nCompleted ${selected.length} ${groupName} test file(s) in ${totalMs}ms`);

if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) {
    console.log(`  ✖ ${f.label} (${f.reason}, ${f.durationMs}ms)`);
  }
  process.exit(1);
}
