import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { loadCandidate, archiveCandidate } from '../core/candidates.js';
import { loadState, saveState } from '../core/state.js';
import { loadConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateId, nowISO } from '../core/ids.js';
import { generateTrapId } from '../core/traps.js';
import { agentCanWriteDirect } from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import type { Constraint, Decision, Trap, Handoff } from '../core/schema.js';

export function runAccept(id: string, by?: string): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let candidate;
  try {
    candidate = loadCandidate(id);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  if (candidate.status !== 'pending') {
    console.error(`Error: Candidate '${id}' is already ${candidate.status}.`);
    process.exit(1);
  }

  const config = loadConfig();
  const approvalPolicy = config.governance?.approval_policy ?? 'review';
  const actor = by ?? process.env.USER ?? process.env.USERNAME ?? 'unknown';
  const curators = config.governance?.curators ?? [];

  // Trust-level bypass: trusted/curator agents can accept without being in governance.curators
  const actorHasTrust = agentCanWriteDirect(actor);

  if (approvalPolicy === 'strict' && curators.length > 0 && !curators.includes(actor) && !actorHasTrust) {
    console.error(
      `Error: strict approval policy enabled. '${actor}' is not in governance.curators and cannot accept candidates.`
    );
    process.exit(1);
  }

  const state = loadState();

  // Promote candidate into canonical state based on type
  switch (candidate.type) {
    case 'constraint': {
      const entryId = generateId('active_constraints');
      const entry: Constraint = {
        id: entryId,
        text: candidate.text,
        created_at: candidate.created_at,
        author: candidate.author,
        author_id: candidate.author_id,
        project_id: candidate.project_id,
        host_id: candidate.host_id,
        session_id: candidate.session_id,
        status: 'active',
        tags: candidate.tags,
      };
      state.active_constraints.push(entry);
      console.log(`✔ Promoted to constraint [${entryId}]`);
      break;
    }
    case 'decision': {
      const entryId = generateId('recent_decisions');
      const entry: Decision = {
        id: entryId,
        text: candidate.text,
        created_at: candidate.created_at,
        author: candidate.author,
        author_id: candidate.author_id,
        project_id: candidate.project_id,
        host_id: candidate.host_id,
        session_id: candidate.session_id,
        related_paths: candidate.related_paths,
        tags: candidate.tags,
      };
      state.recent_decisions.push(entry);
      console.log(`✔ Promoted to decision [${entryId}]`);
      break;
    }
    case 'trap': {
      const entryId = generateTrapId();
      const entry: Trap = {
        id: entryId,
        text: candidate.text,
        created_at: candidate.created_at,
        author: candidate.author,
        author_id: candidate.author_id,
        project_id: candidate.project_id,
        host_id: candidate.host_id,
        session_id: candidate.session_id,
        severity: candidate.severity ?? 'medium',
        tags: candidate.tags,
        visibility: 'shared',
      };
      state.known_traps.push(entry);
      console.log(`✔ Promoted to trap [${entryId}]`);
      break;
    }
    case 'handoff': {
      const entryId = generateId('open_handoffs');
      const entry: Handoff = {
        id: entryId,
        from: candidate.from ?? 'unknown',
        to: candidate.to ?? 'unknown',
        text: candidate.text,
        created_at: candidate.created_at,
        author: candidate.author,
        author_id: candidate.author_id,
        project_id: candidate.project_id,
        host_id: candidate.host_id,
        session_id: candidate.session_id,
        status: 'open',
        tags: candidate.tags,
      };
      state.open_handoffs.push(entry);
      console.log(`✔ Promoted to handoff [${entryId}]`);
      break;
    }
  }

  saveState(state);
  writeFileAtomic(memoryPath('project.md'), generateMarkdown(state));

  // Archive candidate
  candidate.status = 'accepted';
  candidate.resolved_at = nowISO();
  candidate.resolved_by = actor;
  archiveCandidate(candidate, 'accepted');

  appendAuditEntry({
    actor,
    action: 'accept',
    item_id: id,
    item_type: candidate.type,
    after: { type: candidate.type, text: candidate.text },
    reason: actorHasTrust ? 'trusted-agent' : undefined,
  });

  console.log(`✔ Candidate [${id}] accepted and archived.`);
}
