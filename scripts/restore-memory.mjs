#!/usr/bin/env node
/**
 * Emergency memory restoration script.
 * Reads recovered_items_clean.json and writes items to entity-aligned .brainclaw/ paths.
 * Run: node scripts/restore-memory.mjs <path-to-recovered-json>
 */
import fs from 'node:fs';
import path from 'node:path';

const RECOVERED_PATH = process.argv[2] || path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.claude/projects/c--Users-jberdah-Documents-Projets-shared-agent-memory-mvp/recovered_items_clean.json'
);

const BASE = path.join(process.cwd(), '.brainclaw');
const SCHEMA_VERSION = 2;

const DEFAULT_PROVENANCE = {
  actor: 'jberdah',
  actor_id: 'agt_dd0a5357c5e748deafe0d77a89a657de',
  project_id: 'prj_3b89207d76fe4b969776ae04fe0ed755',
  host_id: 'frams99l000391',
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function saveItem(subdir, id, data) {
  const dir = path.join(BASE, subdir);
  ensureDir(dir);
  const filepath = path.join(dir, `${id}.json`);
  const doc = { schema_version: SCHEMA_VERSION, ...data };
  fs.writeFileSync(filepath, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
}

function normalizeTags(tags) {
  if (!tags) return [];
  // Some tags come as comma-separated strings in an array
  return tags.flatMap(t => typeof t === 'string' ? t.split(',').map(s => s.trim()).filter(Boolean) : [t]);
}

function restoreDecision(item) {
  saveItem('memory/decisions', item.id, {
    id: item.id,
    short_label: item.short_label,
    text: item.text,
    created_at: item.created_at || new Date().toISOString(),
    author: item.author || DEFAULT_PROVENANCE.actor,
    author_id: item.author_id || DEFAULT_PROVENANCE.actor_id,
    project_id: item.project_id || DEFAULT_PROVENANCE.project_id,
    tags: normalizeTags(item.tags || []),
    related_paths: item.related_paths,
    provenance: item.provenance || DEFAULT_PROVENANCE,
  });
}

function restoreTrap(item) {
  saveItem('memory/traps', item.id, {
    id: item.id,
    short_label: item.short_label,
    text: item.text,
    severity: item.severity || item.extra?.match?.(/^(low|medium|high|critical)/)?.[1] || 'medium',
    created_at: item.created_at || new Date().toISOString(),
    author: item.author || DEFAULT_PROVENANCE.actor,
    author_id: item.author_id || DEFAULT_PROVENANCE.actor_id,
    project_id: item.project_id || DEFAULT_PROVENANCE.project_id,
    tags: normalizeTags(item.tags || []),
    visibility: item.visibility || 'shared',
    related_paths: item.related_paths,
    provenance: item.provenance || DEFAULT_PROVENANCE,
  });
}

function restoreConstraint(item) {
  saveItem('memory/constraints', item.id, {
    id: item.id,
    short_label: item.short_label,
    text: item.text,
    created_at: item.created_at || new Date().toISOString(),
    author: item.author || DEFAULT_PROVENANCE.actor,
    author_id: item.author_id || DEFAULT_PROVENANCE.actor_id,
    project_id: item.project_id || DEFAULT_PROVENANCE.project_id,
    tags: normalizeTags(item.tags || []),
    related_paths: item.related_paths,
    provenance: item.provenance || DEFAULT_PROVENANCE,
  });
}

function restoreHandoff(item) {
  saveItem('coordination/handoffs', item.id, {
    id: item.id,
    short_label: item.short_label,
    text: item.text,
    from_agent: item.from_agent || 'unknown',
    to_agent: item.to_agent || 'unknown',
    status: item.status || 'pending',
    created_at: item.created_at || new Date().toISOString(),
    author: item.author || DEFAULT_PROVENANCE.actor,
    author_id: item.author_id || DEFAULT_PROVENANCE.actor_id,
    project_id: item.project_id || DEFAULT_PROVENANCE.project_id,
    tags: normalizeTags(item.tags || []),
    related_paths: item.related_paths,
    provenance: item.provenance || DEFAULT_PROVENANCE,
  });
}

function restorePlan(item) {
  const steps = (item.steps || []).map(s => ({
    id: s.id,
    text: s.text,
    status: s.status || 'todo',
    created_at: s.created_at || item.created_at || new Date().toISOString(),
    updated_at: s.updated_at || s.created_at || new Date().toISOString(),
  }));

  saveItem('coordination/plans', item.id, {
    id: item.id,
    short_label: item.short_label,
    text: item.text,
    created_at: item.created_at || new Date().toISOString(),
    updated_at: item.updated_at || item.created_at || new Date().toISOString(),
    author: item.author || DEFAULT_PROVENANCE.actor,
    author_id: item.author_id || DEFAULT_PROVENANCE.actor_id,
    project_id: item.project_id || DEFAULT_PROVENANCE.project_id,
    status: item.status || 'todo',
    priority: item.priority || 'medium',
    tags: normalizeTags(item.tags || []),
    depends_on: item.depends_on || [],
    steps,
    estimated_effort: item.estimated_effort,
  });
}

// --- Main ---
console.log(`Reading recovered items from: ${RECOVERED_PATH}`);
const recovered = JSON.parse(fs.readFileSync(RECOVERED_PATH, 'utf-8'));

const counts = { decisions: 0, traps: 0, constraints: 0, handoffs: 0, plans: 0 };

for (const item of recovered.decisions || []) {
  if (!item.id || !item.text) continue;
  restoreDecision(item);
  counts.decisions++;
}

for (const item of recovered.traps || []) {
  if (!item.id || !item.text) continue;
  restoreTrap(item);
  counts.traps++;
}

for (const item of recovered.constraints || []) {
  if (!item.id || !item.text) continue;
  restoreConstraint(item);
  counts.constraints++;
}

for (const item of recovered.handoffs || []) {
  if (!item.id || !item.text) continue;
  restoreHandoff(item);
  counts.handoffs++;
}

for (const item of recovered.plans || []) {
  if (!item.id || !item.text) continue;
  restorePlan(item);
  counts.plans++;
}

console.log('\nRestored:');
console.log(`  Decisions:   ${counts.decisions}`);
console.log(`  Traps:       ${counts.traps}`);
console.log(`  Constraints: ${counts.constraints}`);
console.log(`  Handoffs:    ${counts.handoffs}`);
console.log(`  Plans:       ${counts.plans}`);
console.log(`  Total:       ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
