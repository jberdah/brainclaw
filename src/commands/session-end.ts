import { execSync } from 'node:child_process';
import { memoryExists } from '../core/io.js';
import { buildOperationalIdentity, clearCurrentSession } from '../core/identity.js';
import { buildContextDiff } from '../core/context-diff.js';
import { listClaims, releaseClaim } from '../core/claims.js';
import { listRuntimeNotes, saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { loadState } from '../core/state.js';
import { createCandidateFromInput } from './reflect.js';
import { suggestCandidateTypes } from './reflect-runtime-note.js';
import { nowISO } from '../core/ids.js';
import { appendAuditEntry } from '../core/audit.js';
import { requireMinimumTrustLevel, requireRegisteredAgentIdentity } from '../core/agent-registry.js';
import { loadSessionSnapshot } from '../commands/session-start.js';

export interface SessionEndOptions {
  session?: string;
  summary?: string;
  agent?: string;
  agentId?: string;
  autoReflect?: boolean;
  autoRelease?: boolean;
  reflectHandoff?: boolean;
  /** Include structured reflection questions in the result for the agent to answer. */
  reflect?: boolean;
  json?: boolean;
  cwd?: string;
}

export const REFLECTION_QUESTIONS = [
  'What was the biggest time waste in this session, and how could it have been avoided?',
  'What should have been done differently (design, process, or approach)?',
  'What should brainclaw itself improve based on this session?',
] as const;

export interface SessionEndResult {
  session_id: string;
  agent: string;
  notes_in_session: number;
  candidates_created: number;
  context_diff?: string;
  summary: string;
  open_work_warning?: OpenWorkWarning;
  /** When reflect=true, these questions should be answered by the agent via bclaw_write_note with tag [reflection]. */
  reflection_prompt?: {
    questions: string[];
    instruction: string;
  };
}

export interface OpenWorkWarning {
  active_claims: { id: string; scope: string; description: string }[];
  in_progress_plans: { id: string; text: string }[];
  auto_released: boolean;
}

export function runSessionEnd(options: SessionEndOptions = {}): void {
  try {
    const result = endSession(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.open_work_warning) {
      const w = result.open_work_warning;
      console.log('⚠ Open work detected at session end:');
      for (const c of w.active_claims) {
        console.log(`  claim [${c.id}] ${c.description}`);
        console.log(`    scope: ${c.scope}`);
      }
      for (const p of w.in_progress_plans) {
        console.log(`  plan  [${p.id}] ${p.text}`);
      }
      if (w.auto_released) {
        console.log('  → Claims auto-released and plans left for manual update.');
      } else {
        console.log('  → Run `brainclaw claim release <id>` and `brainclaw plan update <id> --status done` to clean up.');
      }
    }

    console.log(`✔ Session ended: ${result.session_id} (${result.agent})`);
    console.log(`  Runtime notes in session: ${result.notes_in_session}`);
    if (options.autoReflect) {
      console.log(`  Candidates created from auto-reflect: ${result.candidates_created}`);
    }
    if (result.context_diff) {
      console.log(`  ${result.context_diff}`);
    }
    if (result.reflection_prompt) {
      console.log('\n📝 Session reflection:');
      for (let i = 0; i < result.reflection_prompt.questions.length; i++) {
        console.log(`  ${i + 1}. ${result.reflection_prompt.questions[i]}`);
      }
      console.log(`\n  → Answer with: brainclaw note "your reflection" --tag reflection --tag session:${result.session_id}`);
    }
  } catch (e: unknown) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export function endSession(options: SessionEndOptions = {}): SessionEndResult {
  if (!memoryExists(options.cwd)) {
    throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
  }

  const registered = requireRegisteredAgentIdentity({
    agentName: options.agent,
    agentId: options.agentId,
    cwd: options.cwd,
    allowCurrent: true,
    allowEnv: true,
  });
  requireMinimumTrustLevel(registered, 'contributor');
  const actor = buildOperationalIdentity(registered.agent_name, options.cwd, { agentId: registered.agent_id });

  const sessionId = options.session ?? actor.session_id;
  if (!sessionId) {
    throw new Error('no session ID provided. Use --session <id> or set BRAINCLAW_SESSION_ID.');
  }

  // Hygiene check: find open work belonging to this agent
  const allClaims = listClaims(options.cwd);
  const activeClaims = allClaims.filter(
    (c) => c.status === 'active' && (registered.agent_id ? c.agent_id === registered.agent_id : c.agent === registered.agent_name)
  );
  const state = loadState(options.cwd);
  const claimPlanIds = new Set(activeClaims.map((c) => c.plan_id).filter(Boolean) as string[]);
  const inProgressPlans = state.plan_items.filter(
    (p) => p.status === 'in_progress' && (p.assignee === registered.agent_name || claimPlanIds.has(p.id))
  );

  let openWorkWarning: OpenWorkWarning | undefined;
  if (activeClaims.length > 0 || inProgressPlans.length > 0) {
    if (options.autoRelease) {
      for (const c of activeClaims) {
        releaseClaim(c.id, options.cwd);
      }
    }
    openWorkWarning = {
      active_claims: activeClaims.map(({ id, scope, description }) => ({ id, scope, description })),
      in_progress_plans: inProgressPlans.map(({ id, text }) => ({ id, text })),
      auto_released: options.autoRelease ?? false,
    };
  }

  // Get session notes for summary
  const agentNotes = listRuntimeNotes(actor.agent, options.cwd);
  const sessionNotes = agentNotes.filter(n => n.session_id === sessionId);

  const diff = buildContextDiff({
    session: sessionId,
    cwd: options.cwd,
    includeItems: true,
  });
  const contextDiff = diff?.summary;

  const summaryText = options.summary
    ? options.summary
    : `Session ended — ${sessionNotes.length} runtime note(s) created`;

  // Write session_end runtime note
  const noteId = generateRuntimeNoteId();
  saveRuntimeNote({
    id: noteId,
    agent: actor.agent,
    agent_id: actor.agent_id,
    project_id: actor.project_id,
    session_id: sessionId,
    text: summaryText + (contextDiff ? `\n${contextDiff}` : ''),
    created_at: nowISO(),
    tags: ['session'],
    visibility: 'shared',
    note_type: 'session_end',
  }, options.cwd);

  appendAuditEntry({ action: 'session_end', actor: actor.agent, actor_id: actor.agent_id, item_id: sessionId, item_type: 'session' }, options.cwd);
  clearCurrentSession(options.cwd, sessionId);

  // Reflect-handoff: generate a handoff candidate from git commits since session start
  if (options.reflectHandoff) {
    try {
      const snapshot = loadSessionSnapshot(sessionId, options.cwd);
      const startSha = snapshot?.git_sha;
      const ref = startSha ?? 'HEAD~10';
      const cwd = options.cwd ?? process.cwd();

      const commits = execSync(`git log --oneline ${ref}..HEAD`, { encoding: 'utf-8', cwd }).trim();
      const diffStat = execSync(`git diff --stat ${ref}..HEAD`, { encoding: 'utf-8', cwd }).trim();

      if (commits) {
        const releasedScopes = listClaims(options.cwd)
          .filter((c) => c.status === 'released' && c.agent === registered.agent_name)
          .map((c) => c.scope)
          .join(', ');

        const handoffText = [
          `Session ${sessionId} — auto-generated handoff`,
          '',
          `Commits:\n${commits}`,
          diffStat ? `\nChanged files:\n${diffStat}` : '',
          releasedScopes ? `\nReleased claims: ${releasedScopes}` : '',
          summaryText !== `Session ended — ${sessionNotes.length} runtime note(s) created` ? `\nSummary: ${summaryText}` : '',
        ].filter(Boolean).join('\n');

        createCandidateFromInput(handoffText, 'handoff', {
          author: actor.agent,
          authorId: actor.agent_id,
          sessionId,
          source: `session-end:git-diff:${sessionId}`,
          cwd: options.cwd,
        }, false, false, true);
      }
    } catch { /* non-fatal — no git or no commits */ }
  }

  // Auto-reflect: generate candidates from session notes
  let candidatesCreated = 0;
  if (options.autoReflect && sessionNotes.length > 0) {
    for (const note of sessionNotes) {
      if (note.note_type === 'observation' || !note.note_type) {
        try {
          const detected = suggestCandidateTypes(note.text, note.tags).find((entry) => entry.type !== 'handoff');
          if (!detected || detected.score < 4) {
            continue;
          }
          const creation = createCandidateFromInput(note.text, detected.type, {
            tag: note.tags,
            author: note.agent,
            authorId: note.agent_id,
            projectId: note.project_id,
            sessionId: note.session_id,
            source: `runtime-note:${note.agent}:${note.id}`,
            cwd: options.cwd,
          }, false, false, true);
          if (creation.candidateId) {
            candidatesCreated++;
          }
        } catch { /* skip */ }
      }
    }
  }

  const result: SessionEndResult = {
    session_id: sessionId,
    agent: actor.agent,
    notes_in_session: sessionNotes.length,
    candidates_created: candidatesCreated,
    context_diff: contextDiff,
    summary: summaryText,
    open_work_warning: openWorkWarning,
  };

  if (options.reflect) {
    result.reflection_prompt = {
      questions: [...REFLECTION_QUESTIONS],
      instruction: `Please reflect on this session and answer each question. Write your answers using bclaw_write_note with tags ["reflection", "session:${sessionId}"]. One note per question, or a single combined note.`,
    };
  }

  return result;
}
