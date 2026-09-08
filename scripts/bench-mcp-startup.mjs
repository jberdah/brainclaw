#!/usr/bin/env node
// Fresh CLI subprocess through initialize + tools/list, including store startup.
// Usage: node scripts/bench-mcp-startup.mjs --cwd <project> --cli dist/cli.js
//   [--repeats 3] [--budget-ms 30000] [--out report.json]
// The normal CLI startup maintenance can mutate the selected store.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw Error('Expected --option value');
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
if (!args.has('cwd')) throw Error('--cwd <project> is required; startup maintenance may modify this store');
const cwd = path.resolve(args.get('cwd'));
const cli = path.resolve(args.get('cli') ?? 'dist/cli.js');
const repeats = Number(args.get('repeats') ?? 3);
const budget = Number(args.get('budget-ms') ?? 30000);
if (!Number.isInteger(repeats) || repeats < 1 || !Number.isFinite(budget) || budget <= 0) throw Error('Invalid repeats/budget');
if (!fs.existsSync(cli) || !fs.existsSync(path.join(cwd, '.brainclaw'))) throw Error('CLI or store missing');

function sample() {
  return new Promise(resolve => {
    const start = performance.now();
    const child = spawn(process.execPath, [cli, '--debug', 'mcp'], {
      cwd, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '', stderr = '', initializeMs, outcome;
    const timeout = setTimeout(() => finish({ error: 'timeout' }), Math.max(120000, budget * 2));
    const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    function finish(result) {
      if (outcome) return;
      outcome = { initialize_ms: initializeMs, total_ms: performance.now() - start, ...result };
      clearTimeout(timeout);
      child.stdin.end();
      child.kill();
    }
    child.on('error', error => finish({ error: error.message }));
    child.stdin.on('error', error => finish({ error: error.message }));
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { finish({ error: 'Non-JSON stdout' }); return; }
        if (message.error) { finish({ error: message.error }); return; }
        if (message.id === 1) {
          initializeMs = performance.now() - start;
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          if (!Array.isArray(message.result?.tools)) finish({ error: 'Missing tools array' });
          else finish({ tools: message.result.tools.length });
        }
      }
    });
    child.on('close', code => {
      if (!outcome) finish({ error: `Process exited before tools/list: ${code}` });
      resolve({ ...outcome, stderr });
    });
    send({ id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'startup-benchmark', version: '1' },
    } });
  });
}
const samples = [];
for (let i = 0; i < repeats; i++) {
  const result = await sample(); samples.push(result);
  console.log(JSON.stringify({ sample: i + 1, ...result }));
}
const values = samples.map(s => s.total_ms).sort((a, b) => a - b);
const mid = Math.floor(values.length / 2);
const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
const report = { cli, cwd, node: process.version, at: new Date().toISOString(), budget_ms: budget, median_ms: median, samples };
if (args.has('out')) fs.writeFileSync(args.get('out'), JSON.stringify(report, null, 2) + '\n');
console.log(`median ${median.toFixed(1)} ms; budget ${budget} ms`);
if (samples.some(s => s.error) || median > budget) process.exitCode = 1;
