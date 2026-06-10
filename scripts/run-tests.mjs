import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distTestsDir = path.join(rootDir, 'dist-test', 'tests');
const unitTestsDir = path.join(distTestsDir, 'unit');

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
const unitTests = walk(unitTestsDir);
const smokeTests = allTests.filter((filepath) => filepath.endsWith(`${path.sep}smoke.test.js`));
const unitTestSet = new Set(unitTests);
const smokeTestSet = new Set(smokeTests);
const e2eTests = allTests.filter((filepath) => !unitTestSet.has(filepath) && !smokeTestSet.has(filepath));
const e2eTestSet = new Set(e2eTests);

const groups = {
  default: [...unitTests, ...smokeTests],
  unit: unitTests,
  smoke: smokeTests,
  e2e: e2eTests,
  all: [...unitTests, ...smokeTests, ...e2eTests],
};

const perFileTimeoutMs = {
  unit: 180000,
  smoke: 60000,
  e2e: 90000,
};

function getTestKind(filepath) {
  if (unitTestSet.has(filepath)) {
    return 'unit';
  }
  if (smokeTestSet.has(filepath)) {
    return 'smoke';
  }
  if (e2eTestSet.has(filepath)) {
    return 'e2e';
  }
  return 'e2e';
}

function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes}m ${remainingSeconds.toFixed(1)}s`;
}

function buildBaseEnv() {
  const env = {
    ...process.env,
    BRAINCLAW_SKIP_SETUP_REQUIREMENT: process.env.BRAINCLAW_SKIP_SETUP_REQUIREMENT ?? '1',
  };
  // Agent shells export BRAINCLAW_CWD/_PROJECT pointing at the REAL store.
  // Test helpers spread process.env into every spawned CLI, so without this
  // strip the whole e2e layer anchors to the developer's live project store:
  // assertions read empty test dirs, writes LEAK into the real store, and
  // every command pays real-store lock contention + git commits (observed
  // 5-13s per spawn → file-level TIMEOUTs). Verified 2026-06-10.
  delete env.BRAINCLAW_CWD;
  delete env.BRAINCLAW_PROJECT;
  delete env.BRAINCLAW_CLAIM_ID;
  delete env.BRAINCLAW_AGENT;
  return env;
}

function buildIsolatedEnv(tmpHome) {
  const env = buildBaseEnv();
  env.BRAINCLAW_TEST_MODE = '1';
  env.HOME = tmpHome;
  env.USERPROFILE = tmpHome;
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  return env;
}

function writeCapturedOutput(label, output) {
  if (!output.trim()) {
    return;
  }
  const normalized = output.endsWith('\n') ? output : `${output}\n`;
  console.log(`---- output ${label} ----`);
  process.stdout.write(normalized);
}

export function getSelectedTests(groupName) {
  return groups[groupName];
}

export function createTestDescriptor(filepath) {
  return {
    filepath,
    label: relativeTestPath(filepath),
    kind: getTestKind(filepath),
    timeoutMs: perFileTimeoutMs[getTestKind(filepath)],
  };
}

export async function runTestFile(test, options = {}) {
  const {
    isolatedHome = false,
    captureOutput = false,
    spawnImpl = spawn,
  } = options;
  const tmpHome = isolatedHome ? fs.mkdtempSync(path.join(os.tmpdir(), 'brainclaw-test-home-')) : null;
  const env = isolatedHome ? buildIsolatedEnv(tmpHome) : buildBaseEnv();
  const fileStartedAt = Date.now();

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;

    const child = spawnImpl(process.execPath, ['--test', toPlatformPath(test.filepath)], {
      cwd: rootDir,
      env,
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, test.timeoutMs);

    const finish = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutHandle);
      if (tmpHome) {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
      resolve(result);
    };

    if (captureOutput) {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('error', (error) => {
      const durationMs = Date.now() - fileStartedAt;
      finish({
        ...test,
        ok: false,
        reason: timedOut ? 'TIMEOUT' : 'ERROR',
        durationMs,
        output: `${stdout}${stderr}`,
        error,
      });
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - fileStartedAt;
      if (timedOut) {
        finish({
          ...test,
          ok: false,
          reason: 'TIMEOUT',
          durationMs,
          output: `${stdout}${stderr}`,
        });
        return;
      }
      if (code !== 0) {
        finish({
          ...test,
          ok: false,
          reason: 'FAIL',
          durationMs,
          output: `${stdout}${stderr}`,
        });
        return;
      }
      finish({
        ...test,
        ok: true,
        reason: 'PASS',
        durationMs,
        output: `${stdout}${stderr}`,
      });
    });
  });
}

export async function runSequentialTests(tests, options = {}) {
  const runFile = options.runFile ?? runTestFile;
  const results = [];

  for (const test of tests) {
    console.log(`\n==> ${test.label}`);
    const result = await runFile(test, { isolatedHome: false, captureOutput: false });
    if (!result.ok && result.error) {
      console.error(`Test runner error in ${test.label} after ${formatDuration(result.durationMs)}`);
      console.error(result.error);
    } else if (!result.ok) {
      console.error(`Test file failed: ${test.label} (${formatDuration(result.durationMs)})`);
    } else {
      console.log(`<== ok ${test.label} (${formatDuration(result.durationMs)})`);
    }
    results.push(result);
  }

  return results;
}

export async function runParallelTests(tests, options = {}) {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const runFile = options.runFile ?? runTestFile;
  const results = new Array(tests.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= tests.length) {
        return;
      }

      const test = tests[currentIndex];
      console.log(`\n==> ${test.label}`);
      const result = await runFile(test, { isolatedHome: true, captureOutput: true });
      writeCapturedOutput(test.label, result.output ?? '');

      if (!result.ok && result.error) {
        console.error(`Test runner error in ${test.label} after ${formatDuration(result.durationMs)}`);
        console.error(result.error);
      } else if (!result.ok) {
        console.error(`Test file failed: ${test.label} (${result.reason}, ${formatDuration(result.durationMs)})`);
      } else {
        console.log(`<== ok ${test.label} (${formatDuration(result.durationMs)})`);
      }

      results[currentIndex] = result;
    }
  }

  const workerCount = Math.min(concurrency, tests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function printSummary(groupName, selected, totalMs, results) {
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;

  console.log(`\nSummary for ${groupName}`);
  console.log(`  Total time: ${formatDuration(totalMs)}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log('  Per file:');
  for (const result of results) {
    console.log(`    ${result.ok ? 'PASS' : result.reason} ${result.label} (${formatDuration(result.durationMs)})`);
  }
  console.log(`\nCompleted ${selected.length} ${groupName} test file(s) in ${formatDuration(totalMs)}`);
}

export async function runGroup(groupName, options = {}) {
  const selected = getSelectedTests(groupName);

  if (!selected) {
    throw new Error(`Unknown test group "${groupName}". Expected one of: ${Object.keys(groups).join(', ')}`);
  }

  if (selected.length === 0) {
    throw new Error(`No tests found for group "${groupName}".`);
  }

  const tests = selected.map(createTestDescriptor);
  const sequentialTests = tests.filter((test) => test.kind !== 'e2e');
  const parallelTests = tests.filter((test) => test.kind === 'e2e');
  const startedAt = Date.now();
  const results = [];

  console.log(`Running ${selected.length} ${groupName} test file(s)`);
  if (sequentialTests.length > 0) {
    console.log(`  Sequential: ${sequentialTests.length} unit/smoke file(s)`);
    results.push(...await runSequentialTests(sequentialTests, options));
  }
  if (parallelTests.length > 0) {
    console.log(`  Parallel e2e: ${parallelTests.length} file(s) with worker pool of ${options.concurrency ?? 3} (${perFileTimeoutMs.e2e / 1000}s per file)`);
    results.push(...await runParallelTests(parallelTests, options));
  }

  const totalMs = Date.now() - startedAt;
  printSummary(groupName, selected, totalMs, results);

  return {
    totalMs,
    results,
    failures: results.filter((result) => !result.ok),
  };
}

async function main() {
  const groupName = process.argv[2] ?? 'default';
  try {
    const summary = await runGroup(groupName, { concurrency: 3 });
    if (summary.failures.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
