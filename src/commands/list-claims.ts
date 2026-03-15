import { memoryExists } from '../core/io.js';
import { listClaims } from '../core/claims.js';

export interface ListClaimsOptions {
  json?: boolean;
  all?: boolean;
  project?: string;
  plan?: string;
  agent?: string;
}

export function runListClaims(options: ListClaimsOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let claims = listClaims();
  if (!options.all) {
    claims = claims.filter(c => c.status === 'active');
  }
  if (options.project) {
    claims = claims.filter(c => c.project === options.project);
  }
  if (options.plan) {
    claims = claims.filter(c => c.plan_id === options.plan);
  }
  if (options.agent) {
    claims = claims.filter(c => c.agent === options.agent);
  }

  if (options.json) {
    console.log(JSON.stringify(claims, null, 2));
    return;
  }

  if (claims.length === 0) {
    console.log('No active claims.');
    return;
  }

  const label = options.all ? 'claim(s)' : 'active claim(s)';
  console.log(`${claims.length} ${label}:`);
  console.log('');
  for (const c of claims) {
    const status = c.status !== 'active' ? ` (${c.status})` : '';
    const extras: string[] = [];
    if (c.plan_id) extras.push(`plan ${c.plan_id}`);
    if (c.project) extras.push(`project ${c.project}`);
    const suffix = extras.length ? ` [${extras.join(', ')}]` : '';
    console.log(`  [${c.id}] ${c.agent} → ${c.scope}: ${c.description}${suffix}${status}`);
  }
}
