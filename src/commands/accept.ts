import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { loadCandidate, archiveCandidate, resolveIdOrAlias } from '../core/candidates.js';
import { loadState, saveState } from '../core/state.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { generateTrapIdWithLabel } from '../core/traps.js';
import { requireMinimumTrustLevel, requireRegisteredAgentIdentity } from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import type { Constraint, Decision, Trap, Handoff } from '../core/schema.js';

export interface AcceptResult {
  candidate_id: string;
  candidate_type: 'constraint' | 'decision' | 'trap' | 'handoff';
  promoted_item_id: string;
  actor: string;
}

export function runAccept(id: string, by?: string, cwd?: string): void {
  try {
    const result = acceptCandidate(id, by, cwd);
    console.log(`✔ Promoted to ${result.candidate_type} [${result.promoted_item_id}]`);
    console.log(`✔ Candidate [${id}] accepted and archived.`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

export function acceptCandidate(id: string, by?: string, cwd?: string, byId?: string): AcceptResult {
  if (!memoryExists(cwd)) {
    throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
  }

  const resolvedId = resolveIdOrAlias(id, cwd);
  const candidate = loadCandidate(resolvedId, cwd);

  if (candidate.status !== 'pending') {
    throw new Error(`Candidate '${id}' is already ${candidate.status}.`);
  }

  const actorIdentity = requireRegisteredAgentIdentity({
    agentName: by,
    agentId: byId,
    cwd,
    allowCurrent: true,
    allowEnv: true,
  });
  requireMinimumTrustLevel(actorIdentity, 'trusted');
  const actor = actorIdentity.agent_name;

  const state = loadState(cwd);
  let promotedItemId = '';

  // Promote candidate into canonical state based on type
  switch (candidate.type) {
    case 'constraint': {
      const { id: entryId, short_label } = generateIdWithLabel('active_constraints', cwd);
      const entry: Constraint = {
        id: entryId,
        short_label,
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
      promotedItemId = entryId;
      break;
    }
    case 'decision': {
      const { id: entryId, short_label } = generateIdWithLabel('recent_decisions', cwd);
      const entry: Decision = {
        id: entryId,
        short_label,
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
      promotedItemId = entryId;
      break;
    }
    case 'trap': {
      const { id: entryId, short_label } = generateTrapIdWithLabel(cwd);
      const entry: Trap = {
        id: entryId,
        short_label,
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
      promotedItemId = entryId;
      break;
    }
    case 'handoff': {
      const { id: entryId, short_label } = generateIdWithLabel('open_handoffs', cwd);
      const entry: Handoff = {
        id: entryId,
        short_label,
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
      promotedItemId = entryId;
      break;
    }
  }

  saveState(state, cwd);
  writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state, cwd));

  // Archive candidate (use resolved hash ID)
  candidate.status = 'accepted';
  candidate.resolved_at = nowISO();
  candidate.resolved_by = actor;
  archiveCandidate(candidate, 'accepted', cwd);

  appendAuditEntry({
    actor,
    actor_id: actorIdentity.agent_id,
    action: 'accept',
    item_id: resolvedId,
    item_type: candidate.type,
    after: { type: candidate.type, text: candidate.text },
    reason: 'trusted-agent',
  }, cwd);

  return {
    candidate_id: resolvedId,
    candidate_type: candidate.type,
    promoted_item_id: promotedItemId,
    actor,
  };
}
