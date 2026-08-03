#!/usr/bin/env node
/**
 * store-snapshot — immutable snapshot / verify / restore / shape-fixtures for
 * a brainclaw store (pln#619, dogfood-corpus-snapshot-baseline).
 *
 * WHY. The loaded dogfood store IS the corpus: months of real claims, loops,
 * assignments, journals, debris and edge cases that no synthetic fixture can
 * reproduce. Every curation (candidate triage, GC, migration) destroys part of
 * it. The rule this tool enforces: SNAPSHOT BEFORE CURATION — cleanup must be
 * reversible and traceable, and the regression pack (pln#621) needs a stable
 * baseline to reproduce metrics against.
 *
 * DESIGN. Zero dependencies, plain file copy + manifest + content hash:
 *   create   copy <store> into <out>/store/, write <out>/manifest.json,
 *            then mark every snapshot file read-only. The hash is computed on
 *            the COPY, not the source — a live store can mutate mid-copy (the
 *            events journal appends constantly); hashing the copy makes the
 *            manifest internally consistent with what was actually captured.
 *   verify   recompute counts/bytes/hash over <snapshot>/store and compare to
 *            the manifest. Exit 0 on match, 1 on divergence.
 *   restore  copy <snapshot>/store into an EMPTY target (never in-place),
 *            then verify the restored tree against the same manifest — the
 *            acceptance criterion of pln#619 ("a restored store reproduces the
 *            metrics") executed literally.
 *   fixtures emit SHAPE fixtures (field names, value types, observed enum-ish
 *            values for short fields) per entity collection — NEVER raw
 *            values: the store carries private coordination text and the
 *            fixtures land in a public repo. Raw-value corpora stay inside
 *            the private snapshot; shapes are enough to build synthetic
 *            scenario stores for the regression pack.
 *
 * Snapshots default to ~/.brainclaw/snapshots/<store-basename>/<stamp>/ —
 * OUTSIDE any git repo: the store must never transit through a public remote.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MANIFEST_SCHEMA_VERSION = 1;

// ── walking ─────────────────────────────────────────────────────────────────

function walkFiles(root) {
  /** @type {string[]} relative paths, forward-slash, sorted for determinism */
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  out.sort();
  return out;
}

function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(absPath));
  return hash.digest('hex');
}

/**
 * One deterministic hash over the whole tree: sha256 of the sorted list of
 * `relpath\nsize\nsha256(file)\n` records. Any added/removed/altered file
 * changes it; file mtimes deliberately do NOT (a faithful copy keeps the hash).
 */
function corpusHash(root, files) {
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    const abs = path.join(root, rel);
    const stat = fs.statSync(abs);
    hash.update(`${rel}\n${stat.size}\n${sha256File(abs)}\n`);
  }
  return hash.digest('hex');
}

function collectStats(root, files) {
  const perDir = new Map();
  let bytes = 0;
  for (const rel of files) {
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)';
    const size = fs.statSync(path.join(root, rel)).size;
    bytes += size;
    const cur = perDir.get(top) ?? { files: 0, bytes: 0 };
    cur.files += 1;
    cur.bytes += size;
    perDir.set(top, cur);
  }
  return { files: files.length, bytes, per_dir: Object.fromEntries([...perDir.entries()].sort()) };
}

/**
 * Entity counts: file counts for the known JSON collections plus the section
 * lengths of state.json when it parses. Best-effort — a missing dir simply
 * reports 0; the counts exist so a restored store can be compared to the
 * manifest ("reproduces the metrics") without brainclaw itself installed.
 */
function entityCounts(storeRoot) {
  const countJson = (rel) => {
    const dir = path.join(storeRoot, rel);
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const f of walkFiles(dir)) if (f.endsWith('.json')) n += 1;
    return n;
  };
  const counts = {
    claims: countJson('coordination/claims'),
    assignments: countJson('coordination/assignments'),
    inbox_messages: countJson('coordination/inbox'),
    agent_runs: countJson('coordination/runs'),
    handoffs_files: countJson('coordination/handoffs'),
    sequences: countJson('coordination/sequences'),
    loops: countJson('loops'),
    sessions: countJson('sessions'),
    agents: countJson('agents'),
  };
  try {
    const state = JSON.parse(fs.readFileSync(path.join(storeRoot, 'memory', 'state.json'), 'utf-8'));
    for (const [section, key] of [
      ['active_constraints', 'constraints'], ['recent_decisions', 'decisions'],
      ['known_traps', 'traps'], ['open_handoffs', 'handoffs'], ['plan_items', 'plans'],
    ]) {
      if (Array.isArray(state[section])) counts[key] = state[section].length;
    }
  } catch { /* state.json elsewhere or unparseable — dir counts still stand */ }
  return counts;
}

function copyTree(srcRoot, destRoot, files) {
  for (const rel of files) {
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(srcRoot, rel), dest);
  }
}

function markReadOnly(root, files) {
  for (const rel of files) {
    try { fs.chmodSync(path.join(root, rel), 0o444); } catch { /* best-effort — the manifest hash is the real immutability check */ }
  }
}

function gitHead(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim(); }
  catch { return undefined; }
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdCreate(args) {
  const store = path.resolve(args.store ?? path.join(process.cwd(), '.brainclaw'));
  if (!fs.existsSync(store)) fail(`store not found: ${store}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(args.out ?? path.join(os.homedir(), '.brainclaw', 'snapshots', path.basename(path.dirname(store)), stamp));
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) fail(`snapshot target not empty: ${out}`);

  console.log(`snapshotting ${store}\n         -> ${out}`);
  const sourceFiles = walkFiles(store);
  copyTree(store, path.join(out, 'store'), sourceFiles);

  // Everything below reads the COPY — internally consistent even if the live
  // source mutated during the copy.
  const copyRoot = path.join(out, 'store');
  const copiedFiles = walkFiles(copyRoot);
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    source_path: store,
    source_git_head: gitHead(path.dirname(store)),
    brainclaw_version: args['brainclaw-version'],
    totals: collectStats(copyRoot, copiedFiles),
    entity_counts: entityCounts(copyRoot),
    corpus_hash: corpusHash(copyRoot, copiedFiles),
    rule: 'SNAPSHOT BEFORE CURATION: take one of these before any candidate triage, GC or migration of the source store.',
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  markReadOnly(out, copiedFiles.map((f) => `store/${f}`));

  console.log(`files: ${manifest.totals.files}, bytes: ${manifest.totals.bytes}`);
  console.log(`entity_counts: ${JSON.stringify(manifest.entity_counts)}`);
  console.log(`corpus_hash: ${manifest.corpus_hash}`);
  console.log(`OK snapshot ${out}`);
  return out;
}

function loadManifest(snapshotDir) {
  const p = path.join(snapshotDir, 'manifest.json');
  if (!fs.existsSync(p)) fail(`manifest not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function verifyTreeAgainstManifest(treeRoot, manifest, label) {
  const files = walkFiles(treeRoot);
  const stats = collectStats(treeRoot, files);
  const hash = corpusHash(treeRoot, files);
  const problems = [];
  if (stats.files !== manifest.totals.files) problems.push(`file count ${stats.files} != manifest ${manifest.totals.files}`);
  if (stats.bytes !== manifest.totals.bytes) problems.push(`byte total ${stats.bytes} != manifest ${manifest.totals.bytes}`);
  if (hash !== manifest.corpus_hash) problems.push(`corpus_hash mismatch`);
  const counts = entityCounts(treeRoot);
  for (const [k, v] of Object.entries(manifest.entity_counts ?? {})) {
    if (counts[k] !== v) problems.push(`entity_counts.${k} ${counts[k]} != manifest ${v}`);
  }
  if (problems.length > 0) {
    console.error(`FAIL ${label}:\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`OK ${label}: ${stats.files} files, ${stats.bytes} bytes, hash + entity counts match`);
  return true;
}

function cmdVerify(args) {
  const snap = path.resolve(args.snapshot ?? fail('--snapshot <dir> required'));
  verifyTreeAgainstManifest(path.join(snap, 'store'), loadManifest(snap), `verify ${snap}`);
}

function cmdRestore(args) {
  const snap = path.resolve(args.snapshot ?? fail('--snapshot <dir> required'));
  const target = path.resolve(args.to ?? fail('--to <dir> required'));
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    fail(`restore target not empty: ${target} — restore NEVER overwrites in place; restore to an isolated location and swap manually.`);
  }
  const manifest = loadManifest(snap);
  const src = path.join(snap, 'store');
  const files = walkFiles(src);
  copyTree(src, target, files);
  // Restored copies are working copies: writable again.
  for (const rel of files) {
    try { fs.chmodSync(path.join(target, rel), 0o644); } catch { /* best-effort */ }
  }
  verifyTreeAgainstManifest(target, manifest, `restore ${target}`);
}

/**
 * SHAPE fixtures: per collection, the union of field names with value TYPES
 * and, for short primitive fields (<= 24 chars), the set of observed values
 * (status enums, schema versions, tag vocabulary) — never long free text.
 * That is what a synthetic scenario store needs (pln#621) without leaking a
 * single sentence of private coordination content into a public repo.
 */
function cmdFixtures(args) {
  const store = path.resolve(args.store ?? path.join(process.cwd(), '.brainclaw'));
  const out = path.resolve(args.out ?? fail('--out <dir> required'));
  const collections = {
    claim: 'coordination/claims',
    assignment: 'coordination/assignments',
    inbox_message: 'coordination/inbox',
    agent_run: 'coordination/runs',
    sequence: 'coordination/sequences',
    loop: 'loops',
    session: 'sessions',
  };
  fs.mkdirSync(out, { recursive: true });
  const SHORT = 24;
  // Identifying fields never export VALUES, only type/presence: a hostname or
  // OS username is short enough to pass the length gate and these fixtures
  // land in a public repo (caught live on the first real export: host_id and
  // user values surfaced in session/claim shapes).
  const IDENTITY_FIELD = /host|user|author|owner|email|machine/i;
  for (const [entity, rel] of Object.entries(collections)) {
    const dir = path.join(store, rel);
    if (!fs.existsSync(dir)) continue;
    /** @type {Map<string, { types: Set<string>, values: Set<string>, seen: number }>} */
    const fields = new Map();
    let sampled = 0;
    for (const f of walkFiles(dir)) {
      if (!f.endsWith('.json')) continue;
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; }
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) continue;
      sampled += 1;
      for (const [key, value] of Object.entries(doc)) {
        const slot = fields.get(key) ?? { types: new Set(), values: new Set(), seen: 0 };
        slot.seen += 1;
        const t = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
        slot.types.add(t);
        const identifying = IDENTITY_FIELD.test(key);
        if (!identifying && ((t === 'string' && value.length <= SHORT && !/[a-f0-9]{8}/.test(value)) || t === 'boolean' || t === 'number')) {
          if (slot.values.size < 12) slot.values.add(String(value));
        }
        fields.set(key, slot);
      }
    }
    if (sampled === 0) continue;
    const shape = Object.fromEntries(
      [...fields.entries()].sort().map(([k, v]) => [k, {
        types: [...v.types].sort(),
        presence: `${v.seen}/${sampled}`,
        ...(v.values.size > 0 ? { observed_short_values: [...v.values].sort() } : {}),
      }]),
    );
    fs.writeFileSync(path.join(out, `${entity}.shape.json`), JSON.stringify({ entity, sampled, fields: shape }, null, 2));
    console.log(`shape ${entity}: ${sampled} sampled, ${fields.size} fields`);
  }
  fs.writeFileSync(path.join(out, 'README.md'), [
    '# Store shape fixtures (pln#619)',
    '',
    'Field-shape summaries of a real dogfood brainclaw store: field names, value',
    'types, presence ratios, and observed SHORT values (status enums, schema',
    'versions). No free text and no ids are ever exported — raw-value corpora',
    'stay inside the private snapshot (`store-snapshot.mjs create`).',
    '',
    'Regenerate: `node scripts/store-snapshot.mjs fixtures --store <store> --out <dir>`',
    '',
  ].join('\n'));
  console.log(`OK fixtures ${out}`);
}

// ── entry ───────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; }
      else args[key] = true;
    }
  }
  return args;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
switch (cmd) {
  case 'create': cmdCreate(args); break;
  case 'verify': cmdVerify(args); break;
  case 'restore': cmdRestore(args); break;
  case 'fixtures': cmdFixtures(args); break;
  default:
    console.log('usage: node scripts/store-snapshot.mjs <create|verify|restore|fixtures> [--store <dir>] [--out <dir>] [--snapshot <dir>] [--to <dir>] [--brainclaw-version <v>]');
    process.exit(cmd ? 1 : 0);
}
