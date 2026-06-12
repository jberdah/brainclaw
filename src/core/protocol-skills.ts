/**
 * Protocol-skills pack (pln#519) — workflow-decomposed agent skills.
 *
 * Three SKILL.md files that package brainclaw's critical workflows so an agent
 * loads THE right protocol at the right moment, instead of skimming a
 * monolithic AGENTS.md. Orthogonal to the agent-PROFILE skills
 * (openclaw/nano-/nemo-/pico-/zeroclaw): the same agent can load both. Marked
 * `metadata.protocol: true` so skill-loader UIs can list protocols separately.
 *
 * Design: .brainclaw/coordination/briefs/pln519-protocol-skills-design.md.
 * Content lives here as the single source of truth and is EMBEDDED (not read
 * from a repo file) so it ships and installs identically whether brainclaw runs
 * from source or an npm install — matching ensureUniversalBrainclawSkill.
 *
 * Guard-rails (design §E): skills carry NO dynamic state (claim/loop/plan ids
 * are always live lookups, never literals), reference facade verbs by name only
 * (never re-implement mcp.ts logic), show BOTH the MCP call and the CLI
 * fallback (cold-start / worktree-without-.brainclaw cases), and stay capped at
 * 3 for this version.
 */

export interface ProtocolSkill {
  /** Skill id = directory name = frontmatter name (namespaced `brainclaw-*`). */
  id: string;
  /** One-line trigger matcher for the agent's skill loader. */
  description: string;
  /** Markdown body (everything after the frontmatter). */
  body: string;
}

const SESSION_BODY = `# brainclaw-session

Open / resume / close a working session on a brainclaw project. Prefer the MCP
facade; the \`brainclaw …\` CLI is the fallback when the MCP server is not
reachable (cold start, or a worktree without \`.brainclaw/\`).

## When to use

- Starting a NEW session on a brainclaw project — any first call in the session, or after a context compaction.
- RESUMING outstanding work — \`BRAINCLAW_CLAIM_ID\` is set, or the operator says "continue X".
- About to EDIT a specific scope (file / dir / feature) that should be reserved against other agents.

## Workflow

1. \`bclaw_work(intent='consult')\` — loads project memory and reports active claims. Read \`bootstrap_recommended\`: if true the project has no usable PROJECT.md (see \`brainclaw-multi-agent\` → bootstrap loop).
2. If you will edit a scope, claim it: \`bclaw_work(intent='execute', scope='<path-or-feature>')\`. The response's \`claim_id\` is yours; \`claim_status='created'\` = new, \`'existing'\` = resumed.
3. Do the work. Honor the \`warnings\` array (claim conflicts, sensitive paths, high-severity traps on your scope).
4. When done (committed, tested), \`bclaw_session_end\` — it auto-releases your remaining claims and closes the session record.

CLI fallback: \`brainclaw context --json\` · \`brainclaw claim create "<desc>" --scope <path>\` · \`brainclaw session-end --auto-release\`.

## Anti-rationalizations

- **"I'm just exploring, I'll skip session-end."** → A live claim outlives a crash. The next agent sees your stale claim and is blocked. Auto-release is the zero-cost guarantee.
- **"I know the project, I don't need to consult."** → State changes between sessions (commits, new traps, new constraints). Consult is cheap and surfaces what you'd miss.
- **"I'll claim later once I know the exact scope."** → Claim-before-edit IS the contract; it is exactly what prevents races with parallel agents.

## Red flags

- \`claim_conflicts\` reports another agent's claim on your target scope → STOP. Route through coordination (\`bclaw_coordinate intent='reroute'\` or ask the operator); never override silently.
- High-severity \`[trap]\`/\`[constraint]\` warning on your scope → read it before editing.
- \`bootstrap_recommended=true\` while you're about to make architectural calls → the project has no PROJECT.md; consider a bootstrap loop first.

## Verification

- The \`claim_id\` returned stays stable across subsequent calls (session continuity).
- After session-end, \`bclaw_find(entity='claim', filter={status:'active'})\` shows no active claim of yours on the scope.

## See also

- \`brainclaw-memory-capture\` — for decisions/traps captured DURING the session.
- \`brainclaw-multi-agent\` — for delegating part of the work.
`;

const MEMORY_CAPTURE_BODY = `# brainclaw-memory-capture

Capture project memory at the RIGHT granularity and type, so it is retrievable
later. The entity type is not cosmetic — it drives retrieval and surfacing.

## When to use

- You made a **design call** future agents must respect → **decision**.
- You hit an **externally-imposed rule** you cannot relax alone → **constraint**.
- You found an **environment / process pitfall** another agent would also hit → **trap**.
- You finished a chunk of work to be consumed by another agent → **handoff**.
- A keep-worthy observation that is not a hard decision/constraint/trap → **runtime_note** (lowest signal).
- You are genuinely unsure of the type → **candidate** (carries a proposed \`type\`; a reviewer reclassifies).

## Workflow

1. Pick the type:

   \`\`\`
   Negotiated + recorded as the way forward?        → decision
   Imposed externally, cannot be relaxed by you?    → constraint
   About HOW the system/env/tools behave (not WHAT)? → trap
   A "danger ahead" pointer for a future agent?      → trap
   Output of work to be consumed by another agent?   → handoff
   Unsure between decision/constraint/trap?          → candidate (with type)
   Else                                              → runtime_note
   \`\`\`

2. Write via the canonical grammar: \`bclaw_create(entity='<type>', data={ text, ...required })\`. Declare the classifying field yourself (caller assertion wins over keyword heuristics): a \`decision\` needs an \`outcome\` (e.g. \`proposed\` until ratified — it is enum-validated), a \`trap\` a \`severity\`, a \`constraint\` a \`category\`, a \`candidate\` its proposed \`type\`. For free-form capture, \`bclaw_quick_capture(text, type)\` is the shortcut.
3. Verify it is re-readable: \`bclaw_get(entity='<type>', id='<id>')\` returns your content. If it 404s or errors \`validation_error\`, the write was rejected at the load path — re-check the required fields.

CLI fallback: \`brainclaw create <type> …\` · \`brainclaw quick-capture "<text>" --type <type>\`.

## Anti-rationalizations

- **"I'll write a runtime_note, I'm unsure of the type."** → Notes are the lowest-signal type (aggregated, not surfaced). If it's actionable, pick decision/constraint/trap — being wrong is fine, that's what candidates are for.
- **"I'll add it as a decision AND a runtime_note to be safe."** → Duplicates pollute search and retrieval. Pick ONE.
- **"I'll write the decision without an outcome."** → \`outcome\` is enum-validated; an absent/invalid value is rejected (silently, on older paths). Set \`proposed\` if not yet ratified.
- **"A 5-line trap for a 1-line problem."** → Traps are read under pressure. Severity + symptom + mitigation, scannable.

## Red flags

- The content already exists under a different id → \`bclaw_find\` first; \`bclaw_update\` the existing one instead of duplicating.
- You're about to write 10+ items at once → pause; you're dumping context, not capturing signal. Consolidate.
- The "decision" was proposed by someone else and not yet accepted → it's a \`candidate\`, not a \`decision\`.

## Verification

- \`bclaw_create\` returns an id (e.g. \`dec_…\`).
- \`bclaw_get(entity='<type>', id)\` returns identical content; \`bclaw_search\`/\`bclaw_find\` index it.
- Traps surface in \`bclaw_work\` warnings on the relevant scope.

## See also

- \`brainclaw-session\` — capture happens DURING a session.
- \`brainclaw-multi-agent\` — capture review findings as decisions/traps.
`;

const MULTI_AGENT_BODY = `# brainclaw-multi-agent

Coordinate work across agents — delegate, request review, drive parallel
dispatch, run multi-turn loops. Use when the work exceeds one agent's
competence or when parallelism gains outweigh orchestration cost.

## When to use

- A second pair of eyes before merging → **review loop**.
- An open-ended design needing multiple perspectives → **ideation loop** (or **bootstrap loop** for PROJECT.md genesis).
- N independent sub-tasks runnable in parallel → **dispatch**.
- You're inside a loop someone else opened and must drive your turn → **loop verbs**.

## Workflow — pick the verb first

\`\`\`
Delegate a scope (with a claim)?          → bclaw_coordinate(intent='assign')
Ask an agent for input, no claim?         → bclaw_coordinate(intent='consult')
Review a commit / branch / candidate?     → bclaw_coordinate(intent='review', open_loop=true)
Brainstorm with multiple agents?          → bclaw_coordinate(intent='ideate')
Parallelize a sequence's lanes?           → bclaw_dispatch(intent='execute')
Drive YOUR turn in an open loop?          → bclaw_loop(intent='turn|complete_turn|advance|close')
\`\`\`

### Review loop
1. Commit your changes first (or pass \`allow_dirty=true\` only if the worker doesn't need the dirty files — it spawns from HEAD).
2. \`bclaw_coordinate(intent='review', open_loop=true, review_mode='symmetric', targetAgents=['<agent>'], scope='<commit/branch/feature>', task='<what to review + acceptance bar>')\`.
3. Verify the worker is ALIVE — \`bclaw_dispatch_status(target_id='<asgn_…>')\` (health verdict + recommended action), not the bare \`delivered_and_started\` return.
4. When findings land, apply fixes / push back via another turn.
5. \`bclaw_loop(intent='close', loop_id='<id>', status='completed', reason='<verdict>')\`; release the worker's claim.

### Parallel dispatch
1. A sequence with lane declarations (or a plan with lanes).
2. \`bclaw_dispatch(intent='execute')\` fans the items across agents per their lanes. Before merging the lanes back, run \`brainclaw worktree check\` (pre-merge conflict detection).

## Anti-rationalizations

- **"I'll call \`bclaw_loop(intent='open')\` to start the review."** → STOP. \`open\` creates the loop WITHOUT dispatching a turn; the reviewer never gets the work. Use \`bclaw_coordinate(intent='review', open_loop=true)\` — it opens AND dispatches.
- **"It returned \`delivered_and_started\`, so the worker is running."** → That only means the brief-ack sentinel was touched. Verify with \`bclaw_dispatch_status\`; spawns die silently.
- **"I'll dispatch with uncommitted changes, the worker will see them."** → It spawns from HEAD in a worktree; your dirty files are invisible. Commit, or pass \`allow_dirty=true\` consciously.

## Red flags

- \`agent_run.status='running'\` but the worker pid is dead → silent spawn death; check the captured stderr, retry or reassign. (Do NOT trust a stale \`LANE-RESULT.json\` inherited by the worktree — verify its \`assignment_id\` matches.)
- Cross-project dispatch (\`project='<other>'\`) → auto-spawn is disabled by design; the target picks the brief up async via its own \`bclaw_work\`. Don't block waiting.
- A dispatched worker operates in a worktree that has no \`.brainclaw/\` → its MCP/CLI may be limited (trp#336); it falls back to file-based output. Expect a file deliverable, harvest it.

## Verification

- Dispatch: \`bclaw_dispatch_status(target_id)\` returns \`healthy\` (pid alive, recent fs activity), or a terminal verdict with a recommended next action.
- Review loop: \`bclaw_loop(intent='get', loop_id)\` shows the reviewer slot \`done\` and the findings artifact attached.
- Bootstrap/ideate: at converge the loop is \`completed\` (and for bootstrap, PROJECT.md is materialized at the project root).

## See also

- \`brainclaw-session\` — start a session BEFORE dispatching.
- \`brainclaw-memory-capture\` — capture review findings as typed memory.
- Docs: \`docs/concepts/loop-engine.md\`, \`docs/concepts/dispatch-lifecycle.md\`, \`docs/concepts/parallel-merge-protocol.md\`.
`;

/** The single source of truth for what ships in the protocol-skills pack. */
export const PROTOCOL_SKILLS: ReadonlyArray<ProtocolSkill> = [
  {
    id: 'brainclaw-session',
    description: 'Open / resume / close a working session on a brainclaw project. Use at session start, when resuming after a compaction, or before editing a scope that needs a claim.',
    body: SESSION_BODY,
  },
  {
    id: 'brainclaw-memory-capture',
    description: 'Capture project memory (decision, constraint, trap, runtime_note, handoff, candidate) at the right type and granularity. Use after a design call, hitting a constraint, discovering a trap, or producing a handoff.',
    body: MEMORY_CAPTURE_BODY,
  },
  {
    id: 'brainclaw-multi-agent',
    description: 'Coordinate across agents — delegate, request review, drive parallel dispatch, run multi-turn loops. Use when work exceeds one agent or parallelism beats orchestration cost.',
    body: MULTI_AGENT_BODY,
  },
];

/** Render the full SKILL.md (frontmatter + body) for a protocol skill. */
export function renderProtocolSkill(skill: ProtocolSkill, brainclawVersion: string): string {
  return `---
name: ${skill.id}
description: '${skill.description.replace(/'/g, "''")}'
metadata:
  protocol: true
  brainclaw_version: ${brainclawVersion}
---

${skill.body}`;
}
