/**
 * Static protocol tool-policy name lists (core-owned, pln#622 PR1).
 *
 * Ces listes statiques REMPLACENT les dérivations depuis les annotations
 * d'ALL_TOOLS ; la cohérence avec le catalogue est garantie par
 * tests/unit/protocol-tool-policy.test.ts.
 *
 * (These STATIC lists REPLACE the derivations from ALL_TOOLS annotations for
 * core consumers: core/ must not import the commands/ MCP layer, so the tool
 * names are materialised here instead of being derived from the catalog at
 * import time. The catalog — src/commands/mcp-catalog.ts — KEEPS deriving its
 * own copies from tool annotations; bidirectional set equality between these
 * static lists and the catalog derivations is enforced by
 * tests/unit/protocol-tool-policy.test.ts.)
 *
 * Zero imports by design — this module must stay a pure leaf.
 *
 * @module
 */

/**
 * Tools safe for headless auto-approval (annotation `headlessApproval: 'auto'`
 * in the catalog). Consumed by agent-files writers (Cline autoApprove, Roo
 * alwaysAllow, Codex approval_mode). Order mirrors catalog declaration order
 * so generated agent config files are byte-identical to the derived era.
 */
export const MCP_HEADLESS_AUTO_TOOL_NAMES: string[] = [
  'bclaw_context',
  'bclaw_search',
  'bclaw_estimation_report',
  'bclaw_list_sequences',
  'bclaw_assignment_events',
  'bclaw_list_agents',
  'bclaw_list_instructions',
  'bclaw_get_capabilities',
  'bclaw_list_tools',
  'bclaw_search_tools',
  'bclaw_doctor',
  'bclaw_history',
  'bclaw_audit',
  'bclaw_get_discovery',
  'bclaw_conflict_check',
  'bclaw_who',
  'bclaw_check_policy',
  'bclaw_check_security',
  'bclaw_read_inbox',
  'bclaw_get_thread',
  'bclaw_dispatch_status',
  'bclaw_code_status',
  'bclaw_code_find',
  'bclaw_code_brief',
  'bclaw_send_message',
  'bclaw_ack_message',
  'bclaw_write_note',
  'bclaw_quick_capture',
  'bclaw_claim',
  'bclaw_release_claim',
  'bclaw_session_start',
  'bclaw_session_end',
  'bclaw_add_step',
  'bclaw_complete_step',
  'bclaw_update_step',
  'bclaw_update_handoff',
  'bclaw_work',
  'bclaw_coordinate',
  'bclaw_loop',
  'bclaw_assignment_update',
  'bclaw_assignment_action',
  'bclaw_harvest_candidates',
  'bclaw_find',
  'bclaw_get',
];

/**
 * Narrow "canonical grammar" tool set — the read-side facade entries
 * (session + context) plus the five memory verbs. Consumed by writers
 * (e.g. Hermes' tools.include) that want a minimal advertised surface.
 */
export const MCP_CANONICAL_GRAMMAR_TOOL_NAMES: string[] = [
  'bclaw_context',
  'bclaw_work',
  'bclaw_find',
  'bclaw_get',
  'bclaw_create',
  'bclaw_update',
  'bclaw_transition',
];

/**
 * Tools removed from the MCP surface at the v1.0 cut (Phase 3 slice 3i).
 * Hidden from every `tools/list` response; direct `tools/call` still works
 * as a migration escape hatch.
 */
export const REMOVED_IN_V1_TOOLS: ReadonlySet<string> = new Set([
  'bclaw_list_plans',
  'bclaw_list_candidates',
  'bclaw_list_claims',
  'bclaw_list_actions',
  'bclaw_list_assignments',
  'bclaw_list_runs',
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
