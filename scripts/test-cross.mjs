#!/usr/bin/env node
/**
 * Cross-platform release gate (pln#536, follow-up to the 1.8.0 CI repair).
 *
 * CI runs the full unit set on BOTH Linux (ubuntu) and Windows. A local pass on
 * a single OS is NOT proof of green — two whole failure classes were invisible
 * to a Windows-only run during 1.8.0 (sh-vs-cmd shell behaviour; Windows-runner
 * git path normalization). See trp#482.
 *
 * This reproduces the CI matrix locally before pushing:
 *   1. the host platform (this OS), then
 *   2. Linux via WSL2 when on Windows (skipped gracefully if WSL/node absent).
 *
 * Both legs run `scripts/run-tests.mjs default` against the SAME dist-test
 * (built once by the `test:cross` npm script); WSL sees it through /mnt/<drive>
 * and `wsl` preserves the Windows cwd, so no copy or cd is needed.
 *
 * Exits non-zero if EITHER leg fails. Run via `npm run test:cross`.
 */
import { spawnSync } from 'node:child_process';

const GROUP = process.argv[2] ?? 'default';

function run(label, cmd, args) {
  console.log(`\n========================================`);
  console.log(`=== ${label}`);
  console.log(`========================================`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  return r.status ?? 1;
}

// 1. Host platform.
const hostExit = run(`host suite (${process.platform})`, process.execPath, ['scripts/run-tests.mjs', GROUP]);

// 2. Linux via WSL2 — only meaningful on Windows (on Linux the host leg already
//    IS the Linux signal).
let wslExit = 0;
let wslRan = false;
if (process.platform === 'win32') {
  const probe = spawnSync('wsl', ['-e', 'bash', '-c', 'command -v node'], { encoding: 'utf-8' });
  if (probe.status === 0 && (probe.stdout || '').trim()) {
    wslRan = true;
    // `wsl` (no -l) keeps the Windows cwd, translated to /mnt/<drive>/… — so the
    // already-built dist-test is run in place on Linux.
    wslExit = run('Linux suite (WSL2)', 'wsl', ['-e', 'bash', '-c', `node scripts/run-tests.mjs ${GROUP}`]);
  } else {
    console.log('\n=== Linux suite (WSL2): SKIPPED — wsl or node-in-wsl not available ===');
    console.log('    Install WSL2 + node to get the Linux signal locally (CI still enforces it).');
  }
}

const ok = hostExit === 0 && wslExit === 0;
console.log(`\n----------------------------------------`);
console.log(`Cross-platform result: host(${process.platform})=${hostExit === 0 ? 'PASS' : 'FAIL'}` +
  (wslRan ? `, linux(wsl)=${wslExit === 0 ? 'PASS' : 'FAIL'}` : (process.platform === 'win32' ? ', linux(wsl)=SKIPPED' : '')));
console.log(`----------------------------------------`);
process.exit(ok ? 0 : 1);
