/**
 * MCP tool catalog — every tool descriptor (read + write), the published /
 * default / uninitialized projections, the facade ordering logic, and the
 * annotation-derived tool-name sets.
 *
 * Extracted from mcp.ts (pln#622 PR1). May import mcp-contract.js and the
 * generated schemas; must not import mcp.js (assembly point) — enforced by
 * tests/unit/mcp-dependency-direction.test.ts and the eslint
 * no-restricted-imports guard.
 *
 * @module
 */
import { generatedSchemas } from './mcp-schemas.generated.js';

// SEQUENCE_ITEM_INPUT_SCHEMA a ete RETIRE (pln#599 batch 2). Ce sous-schema JSON manuel
// etait reutilise par create_sequence et update_sequence ; il est desormais derive d'une
// source zod UNIQUE (src/core/sequence-request-schema.ts) et materialise dans
// mcp-schemas.generated.ts. C'est exactement la classe de defaut de trp#180 — un
// sous-schema duplique, corrige d'un cote seulement — qui disparait avec lui.

const { $defs: loopPhaseDefs, ...loopPhaseItemSchema } = generatedSchemas.LoopPhase as typeof generatedSchemas.LoopPhase & {
  $defs?: Record<string, unknown>;
};
const loopSlotInputItemSchema = generatedSchemas.LoopSlotInput;

export const MCP_READ_TOOLS = [
  {
    name: 'bclaw_bootstrap',
    description: 'Derive brownfield bootstrap signals, adaptive interview prompts for CLI or IDE chat agents, and an import proposal from repository docs, manifests, native agent files, and git history.',
    annotations: { tier: 'standard', category: 'context' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional path or scope to tailor the bootstrap.' },
        refresh: { type: 'boolean', description: 'Force a fresh bootstrap scan.' },
        audience: { type: 'string', description: 'Optional interview audience filter: cli, ide_chat, or any.' },
        interview: { type: 'boolean', description: 'Render interview text instead of the summary text.' },
        apply: { type: 'boolean', description: 'Apply the current import proposal into canonical memory. Requires yes: true.' },
        uninstall: { type: 'boolean', description: 'Uninstall the last bootstrap-managed import. Requires yes: true.' },
        yes: { type: 'boolean', description: 'Explicit confirmation for apply/uninstall (mirrors the CLI --yes gate). Without it the call returns confirmation_required and makes no changes.' },
        interviewAnswers: {
          type: 'array',
          description: 'Optional structured interview answers. Each answer may include question_id, response_text, response_items, response_boolean, and explicit suggestions.',
          items: { type: 'object' },
        },
      },
    },
  },
  {
    name: 'bclaw_release_notes',
    description: 'Return the agent-first release notes for the latest installable Brainclaw version from the configured update source. Returns structured highlights, breaking risk, and action recommendation when available.',
    annotations: { tier: 'standard', category: 'context' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    // ── Canonical context read (Phase 3 slice 3c) ──────────────────────
    // Unified dispatcher over the four legacy context reads.
    // Promoted to standard tier at the v1.0 cut.
    name: 'bclaw_context',
    description: 'Unified context read. Dispatches by kind: memory (project memory for a path), execution (local execution env), board (full agent board), board_summary (compact counts), cross_project (linked_projects + incoming_signals only), delta (memory changes since a reference session).',
    annotations: { tier: 'facade', category: 'context', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['memory', 'execution', 'board', 'board_summary', 'cross_project', 'delta'],
          description: 'memory = project memory context; execution = local env/tooling; board = full agent board; board_summary = lightweight counts; cross_project = linked_projects + incoming_signals only; delta = memory changes since `since`.',
        },
        since: {
          type: 'string',
          description: 'For kind=delta: a session_id (sess_...) used as the reference point. Future: also accept ISO timestamp or handoff_id.',
        },
        path: { type: 'string', description: 'kind=memory: file path or glob to filter memory by.' },
        agent: { type: 'string', description: 'Agent name (memory/board kinds).' },
        host: { type: 'string', description: 'Host identifier (memory kind).' },
        allHosts: { type: 'boolean', description: 'Include machine-local runtime from all hosts (memory kind).' },
        profile: { type: 'string', description: 'Memory profile: dev, dense, compact, copilot, quick, briefing, openclaw, ops, research.' },
        includePending: { type: 'boolean', description: 'Include pending candidates (memory kind).' },
        maxItems: { type: 'number', description: 'Max ranked items (memory kind).' },
        maxChars: { type: 'number', description: 'Approximate character budget (memory kind).' },
        digest: { type: 'boolean', description: 'Include deterministic digest (memory kind).' },
        bootstrap: { type: 'boolean', description: 'Enable brownfield bootstrap fallback (memory kind).' },
        refreshBootstrap: { type: 'boolean', description: 'Force fresh bootstrap scan (memory kind).' },
        format: { type: 'string', description: 'Output format (memory kind): markdown, json, template.' },
        explain: { type: 'boolean', description: 'Include ranking reasons (memory kind, markdown format).' },
        compactTemplate: { type: 'boolean', description: 'Use compact template (memory kind, format=template).' },
        includeAgentTooling: { type: 'boolean', description: 'Include agent tooling signals (execution kind).' },
        project: { type: 'string', description: 'Optional: name of a linked project to read context from. Defaults to the current project. Accepts cross_project_links and workspace store-chain children.' },
        budget_tokens: { type: 'number', description: 'Approximate token budget for the payload (~4 chars/token). memory kind: relevance-ranked item fill; board kind: arrays bounded by size.' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'bclaw_search',
    description: 'Full-text search across all memory items (decisions, constraints, traps, candidates, handoffs, plans, sequences) using BM25 scoring.',
    annotations: { tier: 'standard', category: 'memory' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string.' },
        type: { type: 'string', description: 'Filter by section: decisions, constraints, traps, handoffs, candidates, plans, sequences.' },
        section: { type: 'string', description: 'Filter by section (state, candidates, runtime).' },
        since: { type: 'string', description: 'Filter items created after this ISO date.' },
        project: { type: 'string', description: 'Optional project name/path to search. Defaults to the active project.' },
        includeLegacy: { type: 'boolean', description: 'Include records with provenance.kind="legacy" (default false). Response reports excluded_legacy when false.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default 10).' },
        offset: { type: 'number', description: 'Number of results to skip (for pagination).' },
        budget_tokens: { type: 'number', description: 'Optional token budget for the result page (~4 chars/token). The page is size-bounded; has_more/next_offset advertise the rest.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'bclaw_estimation_report',
    description: 'Show estimation accuracy report for completed plans. Returns ratio of estimated vs actual effort per agent.',
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Filter by agent/author name.' },
      },
    },
  },
  {
    name: 'bclaw_list_sequences',
    description: 'List coordination sequences with optional filters on status and id.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: draft, active, archived.' },
        id: { type: 'string', description: 'Get a single sequence by ID or short label.' },
        limit: { type: 'number', description: 'Maximum number of sequences to return (default: 20).' },
        offset: { type: 'number', description: 'Number of sequences to skip (for pagination).' },
        compact: { type: 'boolean', description: 'Return only key fields (id, name, status) to reduce output size.' },
      },
    },
  },
  {
    name: 'bclaw_assignment_events',
    description: 'List correlated runtime events for assignments and runs with filters on assignment, run, claim, session, agent, or event type.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.AssignmentEventsRequest },
  },
  {
    name: 'bclaw_list_agents',
    description: 'List registered agent identities and optionally include bounded reputation summaries.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        includeReputation: { type: 'boolean', description: 'Include bounded reputation summaries for each agent.' },
      },
    },
  },
  {
    name: 'bclaw_list_instructions',
    description: 'List raw or resolved shared instructions with the same filters exposed by the CLI.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'Filter by layer: global, project, agent.' },
        project: { type: 'string', description: 'Project namespace filter.' },
        agent: { type: 'string', description: 'Agent name filter.' },
        active: { type: 'boolean', description: 'Only include active instructions.' },
        resolved: { type: 'boolean', description: 'Resolve effective instructions for the given scope.' },
        path: { type: 'string', description: 'Infer project namespace from a target path when strategy=folder.' },
        limit: { type: 'number', description: 'Maximum number of instructions to return (default: 20).' },
        offset: { type: 'number', description: 'Number of instructions to skip (for pagination).' },
      },
    },
  },
  {
    name: 'bclaw_get_capabilities',
    description: 'List all registered project capabilities with full metadata.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by capability category.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any).' },
      },
    },
  },
  {
    name: 'bclaw_list_tools',
    description: 'List all registered project tools with metadata.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by tool type (workflow, validator, generator, utility, explorer).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any).' },
      },
    },
  },
  {
    name: 'bclaw_search_tools',
    description: 'Search tools by query and tags.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (matches tool name, description, tags).' },
        type: { type: 'string', description: 'Filter by tool type.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (all must match).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'bclaw_doctor',
    description: 'Run health checks on the brainclaw memory store. Returns structured check results with ok/warn/error status and metrics.',
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        migrationCheck: { type: 'boolean', description: 'Include detailed schema migration status.' },
      },
    },
  },
  {
    name: 'bclaw_history',
    description: 'Show full mutation history of a memory item from the audit log.',
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID to retrieve history for.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_audit',
    description: 'View the audit log or generate a governance posture report. Use governance=true for an aggregated view of claims, constraints, traps, instructions and recommendations.',
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Show entries since this ISO date.' },
        actor: { type: 'string', description: 'Filter by actor name or agent ID.' },
        action: { type: 'string', description: 'Filter by action type (create, accept, reject, etc.).' },
        limit: { type: 'number', description: 'Show last N entries (default 20).' },
        governance: { type: 'boolean', description: 'Generate a governance posture report instead of chronological log.' },
        scope: { type: 'string', description: 'Filter governance report by scope (used with governance=true).' },
      },
    },
  },
  {
    name: 'bclaw_get_discovery',
    description: 'Scan workspace for MCP configs, instruction files, skills, hooks, and agent integrations. Returns a structured discovery profile. Saves result to .brainclaw/discovery/ by default.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Force a fresh scan even if a cached profile exists (default: true).' },
        noSave: { type: 'boolean', description: 'Do not persist the discovery profile.' },
      },
    },
  },
  {
    name: 'bclaw_conflict_check',
    description: 'Check for claim conflicts between the current agent and other agents. Returns overlapping scopes.',
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name to check conflicts for (default: current agent).' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
    },
  },
  {
    name: 'bclaw_who',
    description: 'List all active agent sessions on this workspace. Shows user, agent, active project, claims, and last activity for each session.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Include stale sessions (default: false).' },
        gc: { type: 'boolean', description: 'Remove stale sessions and return count.' },
      },
    },
  },
  {
    name: 'bclaw_switch',
    description: 'Switch active project in a multi-project workspace. Session-scoped by default: only this agent sees the switch, other agents are unaffected. Use list=true to see available projects.',
    annotations: { tier: 'standard', category: 'session' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project reference: name, path, or project_id.' },
        list: { type: 'boolean', description: 'List available projects instead of switching.' },
        clear: { type: 'boolean', description: 'Clear active project (return to workspace root).' },
      },
    },
  },
  {
    name: 'bclaw_check_policy',
    description: 'Pre-execution policy check. Verifies claims, constraints, traps and governance instructions for a given scope. Returns blocks (hard stops) and warnings (context to consider). Call before editing to ensure compliance.',
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'File or directory scope to check (e.g. "src/core/foo.ts" or "src/commands").' },
        agent: { type: 'string', description: 'Agent name to check claims for.' },
        agentId: { type: 'string', description: 'Agent id to check claims for.' },
        action: { type: 'string', description: 'Intended action: edit, create, delete (informational, does not change check logic in v1).' },
      },
      required: ['scope'],
    },
  },
  {
    name: 'bclaw_check_security',
    description: 'Check supply chain security scores for packages via Socket.dev. Returns pass/warn/block verdict per package. Requires security.preinstall.enabled in config. Uses the free public Socket MCP endpoint (no auth needed).',
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        packages: { type: 'string', description: 'Comma-separated package names (e.g. "axios,express" or "axios@1.14.1").' },
        ecosystem: { type: 'string', description: 'Package ecosystem: npm or pypi. Defaults to npm.' },
      },
      required: ['packages'],
    },
  },
  {
    name: 'bclaw_read_inbox',
    description: 'Read messages from an agent inbox, newest-first. By default returns only ACTIONABLE messages (pending + read) and hides acknowledged/archived — pass includeAll=true, or a specific status, to widen. Message bodies are previewed (~500 chars) unless full=true; the page is size-bounded by budget_tokens so a read can never blow the token budget. Use markAsRead to auto-mark pending messages as read.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name whose inbox to read. Defaults to calling agent.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        status: { type: 'string', description: 'Filter by an exact status: pending, read, acknowledged, archived. Overrides the actionable default.' },
        includeAll: { type: 'boolean', description: 'Return every status (including acknowledged + archived), disabling the actionable default. Default: false.' },
        type: { type: 'string', description: 'Filter by message type: assign, review, rfc, info, reply.' },
        thread_id: { type: 'string', description: 'Filter by thread ID to see a conversation.' },
        full: { type: 'boolean', description: 'Return complete message bodies instead of ~500-char previews. Each previewed message reports text_length + truncated:true. Default: false.' },
        markAsRead: { type: 'boolean', description: 'Mark pending messages as read. Default: false.' },
        limit: { type: 'number', description: 'Maximum messages to return (default: 20).' },
        offset: { type: 'number', description: 'Skip N messages for pagination.' },
        budget_tokens: { type: 'number', description: 'Cap the returned page size (~4 chars/token). Messages are trimmed until the payload fits; has_more/next_offset let you page the rest.' },
      },
    },
  },
  {
    name: 'bclaw_get_thread',
    description: 'Get all messages in a thread across all agent inboxes. Useful for following RFC discussions or review rounds.',
    annotations: { tier: 'advanced', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Thread ID to retrieve.' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'bclaw_dispatch_status',
    description: 'Consolidated dispatch status — given a `target_id` (asgn_/clm_/lop_/run_), resolves all linked entities (assignment, claim, loop, agent_run), reads the on-disk artefacts (brief-ack sentinel + per-assignment stdout/stderr log tails), checks OS pid liveness, and returns a single health verdict + a recommended next action. Replaces the five separate `bclaw_find` / `bclaw_get` calls a caller would otherwise make to verify a dispatch is actually doing useful work. Particularly useful right after `bclaw_coordinate` returns `execution_status="delivered_and_started"` — that response\'s `verify_with` hint points at this tool by name. See docs/concepts/dispatch-lifecycle.md for the full entity model and FSM details.',
    annotations: { tier: 'facade', category: 'coordination', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'Any one of: an assignment id (`asgn_…`), a claim id (`clm_…`), a loop id (`lop_…`), or an agent_run id (`run_…`). The tool resolves to the assignment scope internally and fetches the rest.' },
        tail_log_lines: { type: 'number', description: 'How many trailing lines of each captured log file (stdout / stderr) to include in the response. Default 20. Pass 0 to omit tails and only return size_bytes.' },
        stall_threshold_ms: { type: 'number', description: 'Age in ms past which a `running` agent_run with a live pid but no recent activity is considered `stalled`. Default 300000 (5 min).' },
      },
      required: ['target_id'],
    },
  },
  {
    name: 'bclaw_code_status',
    description: 'Code Map status for this project: store presence, freshness badge (fresh / stale_changed_files / stale_extractor / stale_grammar / stale_git_head / partial / missing_index), and index stats (files, nodes, edges). Read-only; never refreshes. Pair with bclaw_code_refresh when freshness is missing_index or stale. In a multi-project workspace, cascade=true adds a per-child recap (which nested projects have a built index vs missing_index).',
    annotations: { tier: 'standard', category: 'discovery', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        cascade: { type: 'boolean', description: 'Multi-project workspace recap: also report per-child store presence + freshness for every nested project. No-op outside a multi-project workspace.' },
      },
    },
  },
  {
    name: 'bclaw_code_find',
    description: 'Search the Code Map symbol index for a query (function/class/component/hook/type names). Returns ranked matches with path + score, plus a freshness_badge from the lazy read-path check. Read-only; never refreshes — a missing_index badge means run bclaw_code_refresh first.',
    annotations: { tier: 'standard', category: 'discovery', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol or token to search for (e.g. "App", "useAuth", "dispatch").' },
        limit: { type: 'number', description: 'Max matches to return.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'bclaw_code_brief',
    description: 'Before editing, ask Code Map what to read: returns a ranked suggested_files_to_read list (cap 12) for a symbol or path, related brainclaw memory (cap 5), and a freshness_badge. Read-only; never refreshes.',
    annotations: { tier: 'standard', category: 'discovery', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Symbol name or file path to build a reading brief for.' },
        limit: { type: 'number', description: 'Max suggested files (hard-capped at 12 by the spec).' },
      },
      required: ['target'],
    },
  },
] as const;

const MCP_WRITE_TOOLS = [
  {
    name: 'bclaw_code_refresh',
    description: 'Rebuild the Code Map index for this project (Tree-sitter parse + shards + indexes, behind the per-project lock). scope="changed" (default) reparses changed files; scope="all" does a full refresh + compaction. A live competing lock fails fast with a clear status — refresh never blocks. Returns the resulting freshness_badge. In a multi-project workspace, cascade=true refreshes EVERY nested project into its own store + the root store scoped to files no child owns (zero double-indexing) — so one call at the root indexes the whole monorepo per-project.',
    annotations: { tier: 'standard', category: 'discovery', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['changed', 'all'], description: 'changed (default) reparses changed files only; all does a full refresh with orphan compaction.' },
        cascade: { type: 'boolean', description: 'Multi-project cascade: refresh every nested brainclaw project + a child-scoped root store. No-op outside a multi-project workspace.' },
      },
    },
  },
  {
    name: 'bclaw_dispatch',
    description: 'Unified dispatch entry for sequence-lane parallelization (parallelize plans across lanes). To open a NEW review of a commit/branch, use `bclaw_coordinate(intent="review", open_loop=true, targetAgents=[…])` instead — bclaw_dispatch is for sequence-driven execution, NOT for opening new reviews. `intent` discriminator: analysis (sequence lane status, read-only), execute (default — analyze + generate briefs + send to agents), review (routes an EXISTING already-reflected handoff to a reviewer — only for handoffs produced by `session-end --reflect-handoff` or similar). Consolidates the legacy bclaw_dispatch_analysis / bclaw_dispatch / bclaw_dispatch_review. Returns FacadeResponse; for verification semantics see the same response-validation guidance documented on `bclaw_coordinate`.',
    annotations: { tier: 'facade', category: 'coordination' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['analysis', 'execute', 'review'], description: 'Dispatch intent. Default: execute.' },
        // intent=execute args
        agents: { type: 'array', items: { type: 'string' }, description: 'Only dispatch to these agents. Default: all available.' },
        lanes: { type: 'array', items: { type: 'string' }, description: 'Only dispatch items in these lanes. Also used by intent=analysis.' },
        maxAssignments: { type: 'number', description: 'Max assignments to make (default: all ready). intent=execute only.' },
        model: { type: 'string', description: 'Model to run on spawned workers, decoupled from agent identity (e.g. "sonnet", "gpt-5-codex"). Injected as `<model_flag> <model>` for agents that declare one (claude-code/codex/copilot); no-op for template-pinned identities. Mirrors the CLI `brainclaw dispatch run --model`. intent=execute only.' },
        dryRun: { type: 'boolean', description: 'Preview without sending. Accepted by all intents.' },
        autoExecute: { type: 'boolean', description: 'Attempt to spawn agents after delivery (default: true). intent=execute only.' },
        // intent=review args (forwarded to bclaw_dispatch_review)
        handoffId: { type: 'string', description: 'intent=review: specific handoff ID. Default: auto-detect reviewable handoffs.' },
        reviewer: { type: 'string', description: 'intent=review: specific reviewer agent. Default: any available non-author.' },
        openLoop: { type: 'boolean', description: 'intent=review: open a review_loop alongside the inbox message (default true).' },
        reviewMode: { type: 'string', enum: ['asymmetric', 'symmetric'], description: 'intent=review: loop mode when openLoop=true.' },
        // Common
        agent: { type: 'string', description: 'Dispatcher agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
    },
  },
  {
    name: 'bclaw_send_message',
    description: 'Send a message to another agent\'s inbox. Used for work assignment (type: assign), review requests (type: review), RFC discussions (type: rfc), notifications (type: info), and threaded replies (type: reply). Requires contributor trust.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target agent name.' },
        type: { type: 'string', description: 'Message type: assign, review, rfc, info, reply.' },
        text: { type: 'string', description: 'Message body.' },
        ref: { type: 'string', description: 'Reference to a plan, sequence, handoff, or other entity ID.' },
        payload: { type: 'object', description: 'Structured data (brief, criteria, context).' },
        scope: { type: 'string', description: 'File scope relevant to this message.' },
        requires_ack: { type: 'boolean', description: 'Require recipient to acknowledge. Default: false.' },
        thread_id: { type: 'string', description: 'Thread ID for multi-turn conversations. Omit to start a new thread.' },
        agent: { type: 'string', description: 'Sender agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      },
      required: ['to', 'type', 'text'],
    },
  },
  {
    name: 'bclaw_ack_message',
    description: 'Acknowledge a message in your inbox. Use after processing an assignment or review request.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Message ID or short label to acknowledge.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_setup',
    description: 'Interactive onboarding wizard. Two modes: (1) Quick mode (default): probes the current repo and asks project type + topology, then inits. (2) Batch mode: scan root directories and init multiple repos. Call without step to start — brainclaw auto-detects the best mode.',
    annotations: { tier: 'facade', category: 'session' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'string', description: 'Resume step: "quick_init" (quick mode), or "project_roots"/"repo_selection"/"agent_selection" (batch mode). Omit to start.' },
        choice: { type: 'string', description: 'User choice for the current step.' },
        project_type: { type: 'string', description: 'Quick mode: "standalone", "workspace", or "linked".' },
        topology: { type: 'string', description: 'Quick mode: "embedded" (shared via git) or "sidecar" (local only).' },
        roots: { type: 'string', description: 'Batch mode: comma-separated root paths.' },
        repo_selection: { type: 'string', description: 'Batch mode: repo selection from previous step.' },
        mode: { type: 'string', description: 'Force "quick" or "batch" mode. Default: auto-detect.' },
      },
    },
  },
  {
    name: 'bclaw_init_project',
    description: "Initialize brainclaw at an arbitrary path AND register it as a cross_project_link in the caller's store. Lets an agent operating in workspace A bootstrap a brainclaw project in folder B in one MCP call.",
    annotations: { tier: 'standard', category: 'session', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path of the target folder. Resolved via path.resolve(callerCwd, path).' },
        force: { type: 'boolean', description: 'Pass --force to init (rebuild managed config). Default false.' },
        project_mode: { type: 'string', description: 'Optional project mode (single-project, multi-project, auto).' },
        link_as: { type: 'string', description: 'Optional name to register the cross_project_link under. Defaults to path basename.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'bclaw_write_note',
    description: 'Add a runtime note. Requires contributor trust level or above. Use crossProject to push a runtime-note signal to a linked project (requires role: publisher in cross_project_links config).',
    annotations: { tier: 'standard', category: 'memory' , headlessApproval: 'auto' , schemaSource: 'zod-derived'},
    inputSchema: {
      ...generatedSchemas.WriteNoteRequest,
      required: ['text'],
    },
  },
  {
    name: 'bclaw_quick_capture',
    description: 'Capture free-form text as a decision, trap, constraint, or runtime note. Declare `type` yourself (you know what you are capturing — caller assertion wins); keyword heuristics are only a fallback when type is absent. Contradictions with existing memory are attached as advisory metadata on the candidate, never block promotion.',
    annotations: { tier: 'standard', category: 'memory' , headlessApproval: 'auto' , schemaSource: 'zod-derived'},
    inputSchema: {
      ...generatedSchemas.QuickCaptureRequest,
      required: ['text'],
    },
  },
  {
    name: 'bclaw_claim',
    description: 'Claim a work scope (advisory lock). By default creates an isolated git worktree for the claim (multi-agent safety). Pass advisory:true (or worktree:false) for an advisory-only lock with NO worktree — use this when the work already lives uncommitted in the main tree and a fresh worktree would be counterproductive (trp#431). Requires contributor trust level or above.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.ClaimRequest },
  },
  {
    name: 'bclaw_release_claim',
    description: 'Release a work claim. Callers own their own claims; a trusted+ coordinator releasing another agent\'s claim MUST pass coordinator_override:true (audited).',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.ReleaseClaimRequest },
  },
  {
    name: 'bclaw_session_start',
    description: 'Start a session and capture initial context. Pass includeContext and/or includeBoard to get full context + agent board in a single call, eliminating the need for separate bclaw_get_context and bclaw_get_agent_board calls.',
    annotations: { tier: 'standard', category: 'session' , headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.SessionStartRequest },
  },
  {
    name: 'bclaw_session_end',
    description: 'End a session and optionally auto-reflect observations as candidates.',
    annotations: { tier: 'standard', category: 'session' , headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.SessionEndRequest },
  },
  {
    name: 'bclaw_create_sequence',
    description: 'Create a coordination sequence shared by agents.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'prompt' , schemaSource: 'zod-derived'},
    inputSchema: {
      ...generatedSchemas.CreateSequenceRequest,
      required: ['name'],
    },
  },
  {
    name: 'bclaw_update_sequence',
    description: 'Update a coordination sequence status, metadata, or items.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'prompt' , schemaSource: 'zod-derived'},
    inputSchema: {
      ...generatedSchemas.UpdateSequenceRequest,
      required: ['id'],
    },
  },
  {
    name: 'bclaw_add_step',
    description: 'Add a sub-step to a plan item. Canonical shape is `{ planId, data: { text, title?, assignee? } }`; legacy top-level `{ text, assignee }` still works for backward compatibility. If both are present, data.* wins and a warning is emitted. Requires contributor trust level or above. Pass `project` to target a step in a plan that lives in a linked project (same pattern as the canonical-grammar tools).',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.AddStepRequest },
  },
  {
    name: 'bclaw_complete_step',
    description: 'Mark a plan sub-step as done. Requires contributor trust level or above. Pass `project` to operate on a plan in a linked project.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.CompleteStepRequest },
  },
  {
    name: 'bclaw_update_step',
    description: 'Update a plan sub-step (status, text, assignee). Supports all step statuses: todo, in_progress, testing, done, blocked. Requires contributor trust level or above. Pass `project` to operate on a plan in a linked project.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.UpdateStepRequest },
  },
  {
    name: 'bclaw_delete_step',
    description: 'Remove a sub-step from a plan. Requires contributor trust level or above. Pass `project` to operate on a plan in a linked project.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'prompt' },
    inputSchema: { ...generatedSchemas.DeleteStepRequest },
  },
  {
    name: 'bclaw_delete_plan',
    description: 'Delete a plan item by ID. Requires trusted or curator trust level.',
    annotations: { tier: 'advanced', category: 'coordination' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Plan item ID to delete.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_delete_sequence',
    description: 'Delete a sequence by ID. Requires trusted or curator trust level.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sequence ID to delete.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_delete_memory',
    description: 'Delete a memory item (constraint, decision, or trap) by ID. Requires trusted or curator trust level.',
    annotations: { tier: 'advanced', category: 'memory' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID of the item to delete.' },
        type: { type: 'string', description: 'Item type: constraint, decision, trap.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id', 'type'],
    },
  },
  {
    name: 'bclaw_update_memory',
    description: 'Update text, tags, or trap status of a constraint, decision, or trap by ID. Optionally move it to a different store level. Requires trusted or curator trust level.',
    annotations: { tier: 'advanced', category: 'memory' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID of the item to update.' },
        type: { type: 'string', description: 'Item type: constraint, decision, trap.' },
        text: { type: 'string', description: 'New text (optional).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing).' },
        status: { type: 'string', description: 'New status for traps: active, resolved, expired.' },
        moveToStore: { type: 'string', description: 'Move item to a different store level: local, repo, workspace, user.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id', 'type'],
    },
  },
  {
    name: 'bclaw_add_capability',
    description: 'Register a new project capability. Requires contributor trust level or above.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Capability name.' },
        description: { type: 'string', description: 'Capability description.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Additional tags.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'bclaw_add_tool',
    description: 'Register a new project tool. Requires contributor trust level or above.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name.' },
        description: { type: 'string', description: 'Tool description.' },
        type: { type: 'string', description: 'Tool type: workflow, validator, generator, utility, explorer (default: utility).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Additional tags.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'bclaw_correct_handoff',
    description: 'Write a correction handoff that supersedes an earlier, incorrect one (P6.1 tombstone). The original handoff is left immutable — federation and history still carry both records. The new handoff copies non-overridden fields from the original and sets `supersedes` back at it; the original gets `superseded_by` pointing at the new record.',
    annotations: { tier: 'standard', category: 'coordination', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        originalId: { type: 'string', description: 'ID of the handoff to correct.' },
        text: { type: 'string', description: 'Optional replacement narrative (markdown / free text). Defaults to the original narrative with an appended correction note.' },
        narrative: { type: 'string', description: 'Optional override of the narrative sub-field.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional replacement tags. Defaults to original tags.' },
        reason: { type: 'string', description: 'Short rationale for the correction, appended to the narrative.' },
        agent: { type: 'string', description: 'Author of the correction.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['originalId'],
    },
  },
  {
    name: 'bclaw_update_handoff',
    description: 'Update the status, recipient, contract, or review state of an open handoff. Requires contributor trust level or above. Use targetProject to push the resulting handoff state to a linked project.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Handoff ID to update.' },
        targetProject: { type: 'string', description: 'Push the updated handoff as a cross-project signal to a linked project (name or path).' },
        target_project: { type: 'string', description: 'Snake_case alias of targetProject.' },
        status: { type: 'string', description: 'New status: open, closed.' },
        to: { type: 'string', description: 'New recipient agent name.' },
        files_touched: { type: 'array', items: { type: 'string' }, description: 'Files touched in this handoff.' },
        pre_conditions: { type: 'array', items: { type: 'string' }, description: 'Pre-conditions for the receiving agent.' },
        post_conditions: { type: 'array', items: { type: 'string' }, description: 'Post-conditions the receiving agent must satisfy.' },
        tests_to_verify: { type: 'array', items: { type: 'string' }, description: 'Tests the receiving agent should verify.' },
        linked_plans: { type: 'array', items: { type: 'string' }, description: 'Linked plan IDs.' },
        narrative: { type: 'string', description: 'Free-text narrative of what happened and why, beyond the auto-generated commit list.' },
        reviewer: { type: 'string', description: 'Assigned reviewer for the handoff review.' },
        review_verdict: { type: 'string', enum: ['approve', 'request_changes'], description: 'Structured review verdict for this handoff.' },
        reviewed_by: { type: 'string', description: 'Agent or reviewer who produced the verdict.' },
        review_summary: { type: 'string', description: 'Short summary of the review outcome.' },
        blocking_issues: { type: 'array', items: { type: 'string' }, description: 'Blocking issues raised by review.' },
        suggestions: { type: 'array', items: { type: 'string' }, description: 'Non-blocking suggestions raised by review.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_compact',
    description: 'LLM-driven semantic memory compaction (two-phase). Phase 1 (no args or assess=true): returns pressure assessment and compaction template listing eligible items. Phase 2 (archiveIds + optional newItems): archives specified items and creates new durable memory entries. Safety: creates a backup before archiving.',
    annotations: { tier: 'advanced', category: 'memory' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        assess: { type: 'boolean', description: 'Phase 1: return pressure assessment and compaction template. Default when no archiveIds provided.' },
        archiveIds: { type: 'array', items: { type: 'string' }, description: 'Phase 2: IDs of items to archive (from assessment eligible list).' },
        newItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['constraint', 'decision', 'trap'], description: 'Memory item type.' },
              text: { type: 'string', description: 'Content of the new memory item.' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the new item.' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Severity (traps only). Default: medium.' },
            },
            required: ['type', 'text'],
          },
          description: 'Phase 2: new durable memory items from your compaction summaries.',
        },
        maxItems: { type: 'number', description: 'Max items to show in assessment. Default: 20.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
    },
  },
  {
    name: 'bclaw_work',
    description: 'Facade entry point: start a session, load context, and optionally claim a scope in a single call. intent=execute creates a claim; intent=consult/resume/review skips it. Eliminates the need for separate bclaw_session_start + bclaw_get_context + bclaw_claim calls.',
    annotations: { tier: 'facade', category: 'session' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['execute', 'consult', 'resume', 'review'], description: 'Work intent. "execute" creates a claim on the scope.' },
        scope: { type: 'string', description: 'Scope being worked on (required for execute intent to create a claim).' },
        planId: { type: 'string', description: 'Optional linked plan item ID.' },
        task: { type: 'string', description: 'Optional task description (used as claim description when creating a claim).' },
        messageId: { type: 'string', description: 'Optional message/thread ID for traceability.' },
        contextTarget: { type: 'string', description: 'Optional path passed to bclaw_get_context to filter memory.' },
        project: { type: 'string', description: 'Optional linked project name/path. Routes session, context, claims, audit, and bootstrap probe to that project. Defaults to the current cwd.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        compact: { type: 'boolean', description: 'Return a compact payload (default true). Set to false to include the full context result. Compact mode avoids exceeding MCP token limits on projects with large memory.', default: true },
        budget_tokens: { type: 'number', description: 'Approximate token budget for the context payload. Relevance-ranked fill: highest-scoring items kept until the budget is reached (~4 chars/token).' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'bclaw_coordinate',
    description: 'Multi-agent coordination facade: assign tasks to agents (with claims), consult agents (no claim), create a review candidate, open an ideation loop, reroute an active claim to another agent, or summarize a thread. Returns a FacadeResponse with selected_targets, delivery_plan, artifacts, side_effects, and execution_status. IMPORTANT — execution_status semantics: `delivered_and_started` means the spawn wrapper touched the brief-ack sentinel (`.brainclaw/coordination/runtime/ack/<assignment_id>.ack`) — NOT that the worker is doing useful work. Spawned workers may still die silently before consuming the brief (cf. trap trp_38f63ea4). To verify a dispatch is actually alive, call `bclaw_dispatch_status(target_id=<asgn_…>)` — it reads the runtime sentinels (ack/heartbeat/completed/failed) plus captured stdout/stderr tails and returns a single health verdict + recommended next action (this is the `verify_with` target attached to the response). Do NOT diagnose liveness from the tracked pid: on Windows an ack-wrapped spawn runs under cmd.exe, so `agent_run.pid` is the wrapper (which exits early by design), NOT the real worker — `Get-Process -Id <pid>` reads it dead while the worker is alive and committing. The reconciler trusts the sentinels and infers `completed` from a post-start commit even when the worker never called bclaw_assignment_update. See docs/concepts/dispatch-lifecycle.md for the full FSM + diagnostic decision tree, and docs/integrations/<agent>.md for per-agent spawn semantics (notably codex.md re sandbox MCP availability).',
    annotations: { tier: 'facade', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['assign', 'consult', 'review', 'reroute', 'summarize', 'ideate'], description: 'Coordination intent. assign/review/reroute and multi-agent ideate spawn worker processes; consult/summarize do not. "assign" creates a claim per target agent and spawns a worker on the brief. "consult" delivers the brief to the target inbox(es) WITHOUT creating claims and WITHOUT spawning — targets pick it up via their own bclaw_work. "review" creates a review candidate (and, with open_loop, a review loop). "ideate" opens an ideation loop with the task as the proposal seed; with targetAgents it advances to critique and SPAWNS one worktree-isolated critic worker per target (autoExecute honored, pln#626 Phase 2), otherwise it opens the loop for the champion to drive manually. "reroute" releases the current claim and reassigns. "summarize" reads a thread and returns a summary.' },
        task: { type: 'string', description: 'Brief or task description delivered to target agents. TRANSPORT NOTE (dec#133): a spawned worker\'s capabilities follow its invoke template, not the mere presence of "sandbox". A sandboxed codex worker (`--sandbox workspace-write`, `approval_policy=never`) CAN reach brainclaw MCP — the server runs out-of-sandbox and every tool call is auto-approved — so MCP lifecycle calls (`bclaw_assignment_update`, `bclaw_send_message`, …) do NOT hang. Its one real limit is that `.git` is read-only: it cannot `git commit`, so it must leave fixes uncommitted in the worktree and the coordinator integrates + commits the diff at harvest (never instruct such a worker to commit). Genuinely MCP-less agents (nanoclaw/nemoclaw/picoclaw/zeroclaw) have no MCP at all: for them, prefer file-based protocols (write findings/reply to a markdown file in the worktree; the coordinator harvests it and lifecycle-closes the assignment). See docs/integrations/<agent>.md for the per-agent capability matrix.' },
        scope: { type: 'string', description: 'File or feature scope. Used as claim scope for assign/reroute; as thread id for summarize if threadId is absent.' },
        targetAgents: { type: 'array', items: { type: 'string' }, description: 'Agent names to target. If omitted, all spawnable agents are used.' },
        constraints: { type: 'object', description: 'Optional structured constraints passed alongside the brief (e.g. deadline, reviewCriteria).' },
        threadId: { type: 'string', description: 'Thread ID for summarize intent.' },
        autoExecute: { type: 'boolean', description: 'Attempt to spawn target agents after delivery (default: true). Applies to the spawning intents assign/review/reroute AND to multi-agent ideate (with targetAgents, it spawns one worktree-isolated critic worker per target). consult is inbox-only and ignores autoExecute; summarize just reads a thread and ignores it. When false on a spawning intent, returns command_ready_manual with bash commands for the supervisor to run.' },
        open_loop: { type: 'boolean', description: 'For intent=review only: also open a review Loop on top of the candidate (author + reviewer slots, advance to `findings`, dispatch turns). Default false — existing review callers are unaffected. See docs/concepts/loop-engine.md §Automation.' },
        review_mode: { type: 'string', enum: ['asymmetric', 'symmetric'], description: 'Optional review Loop mode when open_loop=true. `asymmetric` (default) keeps the classical author→reviewer handoff; `symmetric` lets each reviewer turn also apply fixes directly, halving round-trips for spec/doc reviews. Ignored when open_loop is false.' },
        preflight: { type: 'boolean', description: 'pln#533: when open_loop=true, run a trivial validation spawn per reviewer agent BEFORE opening the loop so an environment death (config rejected, auth fail, model mismatch) surfaces instantly with a clear reason instead of a generic loop timeout. Reviewers that fail pre-flight are dropped (with a targeted warning); if all fail, loop creation is skipped. Default true; set false to skip (e.g. you already ran `brainclaw doctor --spawn-check`). Ignored when open_loop is false or BRAINCLAW_NO_SPAWN is set.' },
        client_request_id: { type: 'string', description: 'Caller-minted ULID/UUIDv7 for idempotent retries. Currently observed on intent="review" + open_loop=true: a retry with the same client_request_id returns the cached {candidate_id, loop_id} response instead of creating a duplicate candidate + loop. Safe to pass on other intents — silently ignored.' },
        agent: { type: 'string', description: 'Caller agent name.' },
        agentId: { type: 'string', description: 'Caller registered agent id.' },
        project: { type: 'string', description: 'Optional (pln#359 phase 1b): name of a linked project to dispatch into. When set, claim/assignment/message all land in the target project — the target agent picks the brief up async via its own bclaw_work. Auto-spawn is disabled in cross-project mode. Accepts cross_project_links and workspace store-chain children (see `brainclaw link list`).' },
        allow_dirty: { type: 'boolean', description: 'Override the scope-aware dirty-working-tree guard (trp#371 Tier 2). The guard runs only for worktree-spawning intents (assign/review/reroute) and blocks only when uncommitted files overlap — or cannot be proven disjoint from — the dispatch scope (the worker spawns from HEAD and will not see them). `.brainclaw/` and `.git/` are always excluded. Set true to proceed anyway (the block is downgraded to a warning that lists the overlapping files). Boolean; the string "true"/"false" are also coerced.' },
        ref: { type: 'string', description: 'Optional git ref (commit/branch/tag) for assign/review/reroute and multi-agent ideate: the dispatched worker (or ideate critic) builds its worktree from this ref instead of HEAD. When set, uncommitted working-tree changes are intentionally out of scope and the dirty guard allows the dispatch. Ignored by consult/summarize and single-agent ideate (no worktree).' },
        preset: { type: 'string', description: 'pln#511: loop preset selector — only valid with intent="ideate". When set, the handler bypasses the kind-default ideation phases and opens the loop with the named preset\'s phases / stop_condition / protocol. v1 ships a single preset: "bootstrap" (see src/core/loops/presets/). The name is validated against the preset registry: unknown names are rejected with `unknown_preset`; passing preset with any intent other than "ideate" is rejected with `preset_kind_mismatch` (presets are kind-specific).' },
        model: { type: 'string', description: 'Model to run on the spawned worker, decoupled from agent identity (e.g. "sonnet", "gpt-5-codex", "gpt-5.4"). Injected as `<model_flag> <model>` into the invoke command for agents that declare one (claude-code/codex/github-copilot); no-op for template-pinned pseudo-identities (e.g. claude-sonnet) or agents without a model_flag. Highest-priority link in the model resolution chain (override > lane > identity > default). Injected into the spawn command for the spawning intents (assign/review/reroute) and multi-agent ideate critics, and into the manual command hint for consult; ignored by summarize (which issues no command).' },
      },
      required: ['intent', 'task'],
    },
  },
  {
    name: 'bclaw_loop',
    description: 'Loop engine facade: open/turn/complete_turn/advance/add_artifact/pause/resume/close/get/list multi-turn work loops (review, ideation, implementation, research, debug). Returns a FacadeResponse with the loop thread, the newly-appended event, and a next_expected hint describing the natural next intent. Experimental — schema may evolve; gate production callers behind MCP versioning (pln#392).',
    // schemaSource is informational for now — grep target so future migrators
    // can locate zod-derived tools quickly. The parity test in
    // tests/unit/mcp-zod-parity.test.ts hard-codes its (tool, zod-schema)
    // pairs explicitly; it does NOT enumerate by this annotation. If that
    // test ever moves to annotation-driven enrollment, validate the
    // annotation against a closed enum then. Sister guard: the hand-written
    // facade schemas (bclaw_work, bclaw_coordinate) are NOT zod-derived —
    // tests/unit/mcp-facade-structural-parity.test.ts asserts bidirectional
    // structural parity (keys + enums) between them and their zod request
    // schemas in src/core/facade-schema.ts (pln#622 PR0b).
    annotations: { tier: 'facade', category: 'loops', headlessApproval: 'auto', experimental: true, schemaSource: 'zod-derived' },
    inputSchema: {
      type: 'object',
      ...(loopPhaseDefs ? { $defs: loopPhaseDefs } : {}),
      properties: {
        intent: {
          type: 'string',
          // 'open' is intentionally NOT exposed standalone (pln#542): it
          // created a loop structure without dispatching the first turn, so
          // nothing ever ran. Loops are opened via
          // bclaw_coordinate(intent='review', open_loop=true) or intent='ideate'.
          enum: ['get', 'list', 'turn', 'complete_turn', 'advance', 'add_artifact', 'pause', 'resume', 'close', 'bind'],
          description: 'Loop lifecycle intent for driving turns inside a loop that was already opened via the coordinate facade. To START a loop, use `bclaw_coordinate(intent="review", open_loop=true, targetAgents=[…])` or `intent="ideate"` — that opens the loop AND dispatches the first turn. `bind` (implementation loops only) dispatches the loop\'s linked sequence and advances bind→execute — the engine action for the `bind` phase. See docs/concepts/loop-engine.md.',
        },
        loop_id: { type: 'string', description: 'Target loop id (lop_…). Required for every intent except open and list.' },
        kind: { type: 'string', enum: ['review', 'ideation', 'implementation', 'research', 'debug'], description: 'Loop kind for open / list filter.' },
        title: { type: 'string', description: 'Human-readable title (open).' },
        goal: { type: 'string', description: 'Optional goal statement (open).' },
        phases: { type: 'array', items: loopPhaseItemSchema, description: 'Optional phase list override (open). Items derived from LoopPhaseSchema (zod source) — see mcp-schemas.generated.ts.' },
        slots: { type: 'array', items: loopSlotInputItemSchema, description: 'Optional initial slot specs (open). Items derived from LoopSlotInputSchema (zod source). Each item carries at least { role }.' },
        linked: { type: 'object', description: 'Optional top-level plan/sequence refs (open).' },
        stop_condition: { type: 'object', description: 'Optional stop_condition override (open). Composite any/all supported.' },
        mode: { type: 'string', enum: ['asymmetric', 'symmetric'], description: 'Review mode selector for open (review kind only).' },
        status: { type: 'string', description: 'For intent="list": filter value (any loop status). For intent="close": target final status — accepted values are `completed` | `cancelled` | `blocked` only (NOT `failed`; map crashed/dead loops to `cancelled` with a `reason`).' },
        include_events: { type: 'boolean', description: 'get: include the event journal in the response.' },
        limit: { type: 'number', description: 'list: max loops returned.' },
        offset: { type: 'number', description: 'list: pagination offset.' },
        slot_id: { type: 'string', description: 'Slot id for turn / complete_turn.' },
        role: { type: 'string', description: 'Slot role for turn (resolves the first non-done slot with that role).' },
        input: { type: 'string', description: 'turn: free-form input passed to the slot.' },
        assignment_id: { type: 'string', description: 'turn: assignment id produced by the dispatcher to be recorded on the slot.' },
        dispatch: { type: 'boolean', description: 'turn: whether the caller has already dispatched the downstream work (recorded for auditability; no spawn happens here).' },
        outcome: { type: 'string', enum: ['done', 'failed', 'cancelled'], description: 'complete_turn outcome (default done).' },
        failure_reason: { type: 'string', description: 'complete_turn: optional failure/cancel reason.' },
        artifact: { type: 'object', description: 'complete_turn / add_artifact payload: { phase, type, body?, produced_by?, ref? }.' },
        dry_run: { type: 'boolean', description: 'bind: analyze + report what would dispatch; no spawn, no advance.' },
        lanes: { type: 'array', items: { type: 'string' }, description: 'bind: restrict the dispatch to specific sequence lanes.' },
        auto_execute: { type: 'boolean', description: 'bind: deliver briefs without spawning (→ manual launch commands).' },
        model: { type: 'string', description: 'bind: model override for the dispatched agents.' },
        max_assignments: { type: 'number', description: 'bind: cap assignments made in this bind.' },
        to_phase: { type: 'string', description: 'advance: explicit target phase (otherwise the next phase).' },
        force: { type: 'boolean', description: 'advance: allow going backwards (increments iteration_count).' },
        reason: { type: 'string', description: 'advance / pause / close: optional reason string.' },
        expected_version: { type: 'number', description: 'Accepted for RFC compatibility on mutating intents, but not enforced until lock/CAS wiring lands.' },
        client_request_id: { type: 'string', description: 'Accepted for RFC compatibility on mutating intents, but not enforced until lock/idempotency wiring lands.' },
        project: { type: 'string', description: 'Optional linked project name/path. Routes loop reads and mutations to that project. Defaults to the current cwd.' },
        agent: { type: 'string', description: 'Caller agent name.' },
        agentId: { type: 'string', description: 'Caller registered agent id (enforced for slot-bound auth in complete_turn).' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'bclaw_assignment_update',
    description: 'Report assignment lifecycle status. Part of the Agent SDK runtime protocol. Workers call this to report: accepted (acknowledging receipt), started (work begun), progress (heartbeat), completed (done with artifacts), failed (error), or blocked (external blocker). The assignment_id is provided in the dispatch brief. OWNERSHIP (trp#291): only the agent the assignment is OWNED BY (the dispatched worker) may update it — a different agent (e.g. the coordinator) gets `Agent <x> cannot update assignment owned by <y>`. If you are the coordinator and need to converge a worker run, do NOT call this; verify via bclaw_dispatch_status instead (the reconciler infers completion from sentinels/commits).',
    annotations: { tier: 'standard', category: 'coordination', headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.AssignmentUpdateRequest },
  },
  {
    name: 'bclaw_assignment_action',
    description: 'Resolve or reject a pending ActionRequired item and update the linked Assignment/AgentRun state.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: { ...generatedSchemas.AssignmentActionRequest },
  },
  {
    name: 'bclaw_harvest_candidates',
    description: 'Harvest candidates from worktree inboxes into the main project store. Use this as the coordinator-side bridge for agents running under --sandbox workspace-write (e.g. Codex), which cannot write to the main store via MCP and instead write to their worktree .brainclaw/coordination/inbox/. Requires trusted trust level.',
    annotations: { tier: 'standard', category: 'coordination', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        worktreePaths: { type: 'array', items: { type: 'string' }, description: 'Explicit worktree paths to scan. Defaults to all active worktrees under ~/.brainclaw/worktrees/<project-hash>/.' },
        dryRun: { type: 'boolean', description: 'When true, report what would be harvested without writing anything.' },
        agent: { type: 'string', description: 'Coordinator agent name for runtime event attribution.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: [],
    },
  },
  // ── Canonical CRUD verbs (Phase 3 / v1.0 grammar) ──────────────────
  // Promoted to `standard` tier at the v1.0 cut.
  {
    name: 'bclaw_find',
    description: 'Canonical list query over a brainclaw entity. Default read filter excludes records with provenance.kind="legacy" and auto_reflect records below 0.6 confidence — override via filter.includeLegacy / filter.minAutoReflectConfidence. Tag filters accept `tag: string` for one tag or `tags: string[]` for any-match. For entity="agent_run", filters also accept assignment_id, claim_id, and message_id. Pass `project` to query a linked project instead of the current one. PAGINATION & SIZE (pln#491): returns at most filter.limit items (default 50), and the page is additionally shrunk if it would exceed the MCP size budget. The response carries `total` (full match count), `returned`, and — when more remain — `has_more: true`, `next_offset`, and a `hint`; pass `filter.offset=<next_offset>` (or a narrower filter) to page rather than expecting everything at once. ORDERING: results follow on-disk/load order, NOT recency — do not assume the first item is the newest (trp#291); filter explicitly (e.g. status, plan_id) to target what you need.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name: plan | decision | constraint | trap | handoff | runtime_note | candidate | sequence | claim | action | assignment | agent_run | agent (read-only, redacted projection) | cross_project_link. Others not yet wired.' },
        filter: { type: 'object', description: 'Filter keys (ANY entity): status, tag (single tag), tags (array, any-match), author, plan_id, source, auto_generated, limit, offset, includeLegacy (bool, default false), minAutoReflectConfidence (0-1, default 0.6). ENTITY-SCOPED keys (rejected with a validation_error if used with any other entity): assignment_id, claim_id, message_id — ONLY for entity="agent_run"; scope ("project" default | "global", the latter unions the dispatchable catalog + adds dispatchable/registered) and includeReputation (bool — attaches a public reputation summary per agent) — ONLY for entity="agent". Unknown/mis-scoped keys are rejected loudly.' },
        project: { type: 'string', description: 'Optional: name (or path/basename) of a linked project to query. Defaults to the current project. Only cross_project_links (config.yaml) and workspace store-chain children are accepted — list with `brainclaw link list`.' },
        budget_tokens: { type: 'number', description: 'Optional token budget for the page payload (~4 chars/token). Tightens the default size cap; pagination metadata (has_more/next_offset) still applies.' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'bclaw_get',
    description: 'Fetch a single brainclaw entity by id or short_label. Pass `project` to fetch from a linked project instead of the current one.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        id: { type: 'string', description: 'Entity id (e.g. dec_ab12cd) or short_label (e.g. dec#42).' },
        project: { type: 'string', description: 'Optional: name of a linked project to fetch from. Defaults to the current project. See `brainclaw link list` for accepted names.' },
        budget_tokens: { type: 'number', description: 'Optional token budget (~4 chars/token). Bounds unbounded fields (e.g. handoff snapshot diffs).' },
      },
      required: ['entity', 'id'],
    },
  },
  {
    name: 'bclaw_create',
    description: 'Create a new brainclaw entity. Data fields are entity-specific; see src/core/schema.ts. Pass `project` to create in a linked project instead of the current one.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        data: { type: 'object', description: 'Create payload (e.g. { text, author, tags }).' },
        project: { type: 'string', description: 'Optional: name of a linked project to create the entity in. Defaults to the current project. Identity (author/agent) is resolved from the source registry — no need to be registered in the target.' },
      },
      required: ['entity', 'data'],
    },
  },
  {
    name: 'bclaw_update',
    description: 'Partial update of mutable fields. Fields not in EntityRegistry.updatable are rejected — use bclaw_transition for status changes. Pass `project` to update an entity in a linked project instead of the current one.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        id: { type: 'string', description: 'Entity id.' },
        patch: { type: 'object', description: 'Fields to update (subset of EntityRegistry.updatable).' },
        project: { type: 'string', description: 'Optional: name of a linked project to update the entity in. Defaults to the current project.' },
      },
      required: ['entity', 'id', 'patch'],
    },
  },
  {
    name: 'bclaw_remove',
    description: 'Remove a brainclaw entity. Archives by default; pass purge:true to hard-delete where supported. Pass `project` to remove from a linked project instead of the current one.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        id: { type: 'string', description: 'Entity id.' },
        purge: { type: 'boolean', description: 'Hard-delete instead of archive. Default false.' },
        project: { type: 'string', description: 'Optional: name of a linked project to remove the entity from. Defaults to the current project.' },
      },
      required: ['entity', 'id'],
    },
  },
  {
    name: 'bclaw_transition',
    description: 'Transition an entity to a new status. Validated against EntityRegistry.transitions. Returns the triggered side-effect tags. Pass `project` to transition an entity in a linked project instead of the current one. For entity="claim": released/stale transitions are ownership-checked — non-owners must pass coordinator_override:true (trusted+ trust level required).',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        id: { type: 'string', description: 'Entity id.' },
        to: { type: 'string', description: 'Target status.' },
        reason: { type: 'string', description: 'Optional free-text reason, audited alongside the transition.' },
        project: { type: 'string', description: 'Optional: name of a linked project to transition the entity in. Defaults to the current project.' },
        coordinator_override: { type: 'boolean', description: 'entity="claim" only: opt-in override for a trusted+ caller releasing/staling a claim they do NOT own. Audited when used. trp#928.' },
      },
      required: ['entity', 'id', 'to'],
    },
  },
  {
    name: 'bclaw_move',
    description: 'Relocate a brainclaw item to another project in a multi-project workspace, PRESERVING its id (so pln#/dec# references stay stable). Relocatable entities: plan, decision, constraint, trap, handoff, sequence. Execution-local entities (claim, assignment, agent_run, session) are NOT relocatable — they stay in the project where the work ran. Refuses on id collision in the target, a missing source, or an active claim on the item (unless force). Audits both stores.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name (plan, decision, constraint, trap, handoff, sequence).' },
        id: { type: 'string', description: 'Entity id to move.' },
        to_project: { type: 'string', description: 'Target project: name, path, or basename.' },
        from_project: { type: 'string', description: 'Source project (defaults to the current project).' },
        force: { type: 'boolean', description: 'Move even if an active claim references the item. Default false.' },
      },
      required: ['entity', 'id', 'to_project'],
    },
  },
] as const;

/**
 * Combined catalog of every brainclaw MCP tool descriptor (read + write).
 * Exposed so tests can iterate inputSchemas (e.g. mcp-input-schema-strict.test.ts
 * runs ajv strict over each entry to prevent Copilot/Cursor-incompatible drift —
 * see trp#180 + pln#494).
 */
export const ALL_TOOLS = [...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS];

/**
 * Canonical list of all brainclaw MCP tool names, derived from ALL_TOOLS.
 * Source-of-truth consumed by agent integration writers (agent-files.ts)
 * to emit per-tool approval entries for each agent surface: Cline
 * `autoApprove`, Roo `alwaysAllow`, Codex `approval_mode`, etc. When a new
 * tool is registered in MCP_READ_TOOLS or MCP_WRITE_TOOLS it automatically
 * propagates here — no manual catalog sync required.
 */
export const MCP_TOOL_NAMES: string[] = ALL_TOOLS.map((tool) => tool.name);

/**
 * Subset of MCP_TOOL_NAMES for tools that are safe for headless auto-approval.
 * Excludes dispatch, architectural gates (accept/reject), plan creation, setup,
 * switch, bootstrap, memory deletes, and other operations that warrant human review.
 * Consumed by agent-files writers (Cline autoApprove, Roo alwaysAllow, Codex approval_mode).
 */
export const MCP_HEADLESS_AUTO_TOOL_NAMES: string[] = ALL_TOOLS
  .filter((tool) => (tool as { annotations?: { headlessApproval?: string } }).annotations?.headlessApproval === 'auto')
  .map((tool) => tool.name);

export type McpToolTier = 'facade' | 'standard' | 'advanced';

/**
 * Narrow "canonical grammar" tool set — the read-side facade entries
 * (session + context) plus the five memory verbs (find / get / create /
 * update / transition). Consumed by writers (e.g. Hermes' tools.include)
 * that want a minimal advertised surface rather than the full headless-auto
 * catalog. Coordination facades (dispatch, coordinate, loop) are excluded
 * because narrow-surface agents shouldn't be routing work.
 *
 * Derivation rule (no hand-curated array):
 *   - tier=facade AND category in {session, context} AND headlessApproval=auto
 *   - OR name in the canonical memory verbs
 *
 * Adding a new memory grammar verb is the only edit that requires touching
 * this file; everything else propagates from ALL_TOOLS annotations (pln#546 step 2).
 */
const _CANONICAL_GRAMMAR_MEMORY_VERBS = new Set([
  'bclaw_find',
  'bclaw_get',
  'bclaw_create',
  'bclaw_update',
  'bclaw_transition',
]);
export const MCP_CANONICAL_GRAMMAR_TOOL_NAMES: string[] = ALL_TOOLS
  .filter((tool) => {
    const ann = (tool as { annotations?: { tier?: string; category?: string; headlessApproval?: string } }).annotations ?? {};
    if (
      ann.tier === 'facade'
      && (ann.category === 'session' || ann.category === 'context')
      && ann.headlessApproval === 'auto'
    ) {
      return true;
    }
    return _CANONICAL_GRAMMAR_MEMORY_VERBS.has(tool.name);
  })
  .map((tool) => tool.name);

/**
 * Tools removed from the MCP surface at the v1.0 cut (Phase 3 slice 3i).
 * Handlers remain in place defensively, but these names are hidden from
 * every `tools/list` response — including `catalog: "all"`. Callers
 * should migrate to the canonical grammar (see
 * `docs/mcp-schema-changelog.md` 1.0.0 block for the full replacement
 * map).
 */
export const REMOVED_IN_V1_TOOLS: ReadonlySet<string> = new Set([
  'bclaw_list_plans',
  'bclaw_list_candidates',
  'bclaw_list_claims',
  'bclaw_list_actions',
  'bclaw_list_assignments',
  'bclaw_list_runs',
  // pln#625 — the last surviving bclaw_list_* tool. Retired in favour of
  // bclaw_find(entity='agent'), which now carries the redacted projection AND
  // the includeReputation join. Handler stays as a redirect escape-hatch.
  'bclaw_list_agents',
  'bclaw_read_handoff',
  'bclaw_create_plan',
  'bclaw_update_plan',
  'bclaw_create_candidate',
  'bclaw_accept',
  'bclaw_reject',
  'bclaw_get_execution_context',
  'bclaw_get_agent_board',
  'bclaw_get_agent_board_summary',
  'bclaw_dispatch_analysis',
  'bclaw_dispatch_review',
  'bclaw_update_handoff',
  'bclaw_get_context',
]);

export const LEGACY_READ_TOOL_HANDLERS = new Set<string>([
  'bclaw_get_context',
  'bclaw_get_execution_context',
  'bclaw_get_agent_board',
  'bclaw_get_agent_board_summary',
  'bclaw_list_plans',
  'bclaw_list_candidates',
  'bclaw_list_claims',
  'bclaw_list_actions',
  'bclaw_list_assignments',
  'bclaw_list_runs',
  'bclaw_list_agents',
  'bclaw_read_handoff',
]);

/** All tools minus the v1.0 removal set. Used by every tools/list branch and governance guards. */
export const PUBLISHED_TOOLS = ALL_TOOLS.filter((tool) => !REMOVED_IN_V1_TOOLS.has(tool.name));

/**
 * Canonical facade order — drives what a fresh agent sees first in tools/list.
 *
 * Mental model for the default agent (doing its own work, not orchestrating):
 *   1. bclaw_work     — entry point: session + context + claim in one call.
 *   2. bclaw_context  — explicit memory read when bclaw_work isn't enough.
 *   3. bclaw_coordinate / bclaw_dispatch / bclaw_loop — ESCALATION path for
 *      agents that need to assign work, dispatch other agents, or drive
 *      multi-turn loops. Optional for most sessions.
 *   4. bclaw_setup    — one-time interactive onboarding.
 *
 * The typical working loop is: bclaw_work → canonical grammar
 * (bclaw_find/get/create/update/remove/transition) → bclaw_release_claim.
 * Coordination facades are not the default path.
 * (pln#397 + Codex audit P2, refined after user feedback on orchestration bias.)
 */
export const FACADE_ORDER = [
  'bclaw_work',
  'bclaw_context',
  'bclaw_coordinate',
  'bclaw_dispatch',
  'bclaw_dispatch_status',
  'bclaw_loop',
  'bclaw_setup',
] as const;

function tierRank(tool: { annotations?: { tier?: string } }): number {
  const tier = tool.annotations?.tier;
  if (tier === 'facade') return 0;
  if (tier === 'standard') return 1;
  return 2; // advanced or missing
}

function facadePositionalRank(name: string): number {
  const idx = (FACADE_ORDER as readonly string[]).indexOf(name);
  return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
}

/**
 * Tools with tier facade or standard — returned by default. Advanced tools
 * require catalog=all. Sort rules (pln#397 Codex P2):
 *   1. tier: facade first, then standard.
 *   2. inside facades: FACADE_ORDER puts work/coordinate/context/dispatch/loop/setup
 *      at the head — the sequence a new agent should learn in.
 *   3. inside standards: original declaration order (stable-sort fallback via index).
 */
export const DEFAULT_PUBLISHED_TOOLS = PUBLISHED_TOOLS
  .filter((tool) => {
    const tier = (tool as { annotations?: { tier?: string } }).annotations?.tier;
    return tier === 'facade' || tier === 'standard';
  })
  .map((tool, index) => ({ tool, index }))
  .sort((a, b) => {
    const tierDiff = tierRank(a.tool) - tierRank(b.tool);
    if (tierDiff !== 0) return tierDiff;
    if (tierRank(a.tool) === 0) {
      const pos = facadePositionalRank(a.tool.name) - facadePositionalRank(b.tool.name);
      if (pos !== 0) return pos;
    }
    return a.index - b.index;
  })
  .map(({ tool }) => tool);

/**
 * Minimal catalog served while the project memory at cwd is absent.
 * Instead of refusing to boot (the historical exit(1)), the server starts
 * in "setup mode" so an agent landing on a fresh repo can initialize it
 * via bclaw_setup without a CLI shell-out + session-reload discontinuity.
 */
export const UNINITIALIZED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bclaw_setup',
  'bclaw_init_project',
  'bclaw_doctor',
]);

export const UNINITIALIZED_PUBLISHED_TOOLS = PUBLISHED_TOOLS.filter(
  (tool) => UNINITIALIZED_TOOL_NAMES.has(tool.name),
);

export function buildUninitializedStateMessage(cwd: string): string {
  return `Project memory not initialized at ${cwd}. The brainclaw MCP server is running in setup mode: only bclaw_setup, bclaw_init_project and bclaw_doctor are available. Call bclaw_setup to initialize this repo — the full tool catalog activates automatically afterwards.`;
}
