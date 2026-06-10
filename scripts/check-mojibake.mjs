#!/usr/bin/env node
// Reject UTF-8-as-cp1252 mojibake ("â€" — the visible 'â€' prefix of
// a double-encoded em dash/quote) anywhere in src/. These artifacts ship
// verbatim into generated agent instruction files.
import fs from 'node:fs';
import path from 'node:path';

const MOJIBAKE = /â€/;
const root = path.resolve(import.meta.dirname, '..', 'src');

const failures = [];

function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full);
      continue;
    }
    if (!/\.(ts|js|mjs|cjs|md|json|yaml|yml)$/.test(entry.name)) continue;
    const lines = fs.readFileSync(full, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (MOJIBAKE.test(line)) {
        failures.push(`${path.relative(process.cwd(), full)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
}

scan(root);

if (failures.length > 0) {
  console.error('Mojibake detected (â€ — double-encoded UTF-8). Fix the encoding:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('No mojibake in src/.');
