/**
 * Observer-mode helper (asgn_8a3790f6 / pln#558 step 1).
 *
 * When `BRAINCLAW_OBSERVER=1` is set in the process environment, the brainclaw
 * store treats this process as a passive observer (a dashboard, the VS Code
 * extension, an inspection script) and suppresses every read-path side effect:
 *
 *   - auto-acknowledge of open handoffs in the coordination snapshot
 *   - lazy reconciliation of agent_run records during read paths
 *   - cursor advancement in readUnseenEvents
 *   - implicit heartbeat / auto-registration of identity
 *
 * A dashboard is not an agent. Reading the board must never mutate the store
 * it observes — that loop is what caused the 2026-06-10 lock-contention storm
 * (the VS Code extension's poll re-wrote and git-committed the entire store
 * under the mutation lock, holding it >5s and timing out every other writer).
 *
 * The flag is intentionally an environment variable — workers inherit it from
 * the parent, so a single setting at MCP-server spawn time covers every read
 * dispatched through the worker pool.
 */
export function isObserverMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.BRAINCLAW_OBSERVER ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
