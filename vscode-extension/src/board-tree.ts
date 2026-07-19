import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { McpClient } from './mcp-client';
import {
  resolveBrainclawSpawnPlan,
  type BrainclawSpawnPlan,
  type ResolveResult,
} from './brainclaw-resolver';
import {
  STALE_MS,
  agentFreshness,
  formatRelativeAge,
  isAutoCandidate,
  isStale,
  paginatedFind,
  priorityLetter,
  timeAgo,
  type Freshness,
} from './tree-helpers';
import type { OpenEntityArgs, SupportedEntity } from './content-provider';
import { BoardObserver, mergeCounts, type CursorMemento, type SeedCounts } from './board-observer';
import { filterPending, selectInProgress } from './board-projection';

export interface BoardProject {
  path: string;
  name: string;
  relativePath: string;
  isWorkspaceRoot: boolean;
}

type TreeNodeType = 'leaf' | 'project' | 'section';

export class BrainclawTreeItem extends vscode.TreeItem {
  // label/description/iconPath are intentionally writable so _ensureSectionItem
  // (pln#457) can refresh a cached section header in place without re-creating
  // the instance. VS Code reads these via getTreeItem() on fire(), so mutation
  // is safe as long as we also fire the subtree.
  public label: string;
  public description?: string;
  public iconPath?: vscode.ThemeIcon | string | vscode.Uri;

  constructor(
    label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    description?: string,
    iconPath?: vscode.ThemeIcon | string | vscode.Uri,
    tooltip?: string | vscode.MarkdownString,
    public readonly contextValue?: string,
    public readonly itemId?: string,
    public readonly projectPath?: string,
    public readonly sectionId?: string,
    public readonly nodeType: TreeNodeType = 'leaf',
    treeId?: string,
  ) {
    super(label, collapsibleState);
    this.label = label;
    this.description = description;
    this.iconPath = iconPath;
    if (tooltip !== undefined) this.tooltip = tooltip;
    if (contextValue) this.contextValue = contextValue;
    if (treeId) this.id = treeId;
  }
}

/**
 * Attach entity preview behaviour to a tree item:
 *  - clicking the item runs `brainclaw.openEntity` and opens a markdown preview
 *  - the tooltip becomes a trusted MarkdownString with an "Open preview" link
 *
 * Called per entity row so the main loop stays lean; `summary` is the
 * human-friendly multi-line string the caller already built for the plain
 * tooltip (we reuse it so UI text stays consistent).
 */
function attachEntityPreview(
  item: BrainclawTreeItem,
  entity: SupportedEntity,
  id: string | undefined,
  projectPath: string | undefined,
  summary: string | undefined,
): void {
  if (!id || !projectPath) return;
  const args: OpenEntityArgs = { entity, id, projectPath };
  const encoded = encodeURIComponent(JSON.stringify([args]));

  item.command = {
    command: 'brainclaw.openEntity',
    title: 'Open preview',
    arguments: [args],
  };

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportHtml = false;
  if (summary) {
    md.appendMarkdown(summary.split('\n').map((line) => line.trim()).filter(Boolean).join('  \n'));
    md.appendMarkdown('\n\n');
  }
  md.appendMarkdown(`[Open preview ▸](command:brainclaw.openEntity?${encoded})`);
  item.tooltip = md;
}

interface BoardSummaryCounts {
  plans: number;
  claims: number;
  assignments: number;
  runs: number;
  actions: number;
  agents: number;
  sessions: number;
  /**
   * pln#559 step 3 — failed agent_runs visible in the current snapshot.
   * Drives the 'assignment failed' toast in `notifications: all` mode (D7)
   * so the operator hears about silent_deaths without watching the tree.
   */
  failedRuns?: number;
}

export type BrainclawStatusSummary = BoardSummaryCounts;

interface SectionCacheEntry {
  board: BoardData | null;
  expiresAt: number;
  error?: string;
}

interface BoardData {
  active_plans: any[];
  active_claims: any[];
  active_assignments?: any[];
  active_runs?: any[];
  active_actions?: any[];
  open_handoffs: any[];
  runtime_notes: any[];
  other_agents?: any[];
  active_sequence?: any;
  known_traps?: any[];
  pending_candidates?: any[];
  linked_projects?: any[];
  incoming_signals?: any[];
  /**
   * Server-computed advisory strings ("19 high-priority plans available",
   * "consider claiming scope X", …). Produced by bclaw_context; rendered as
   * read-only leaf items under the Review queue section so the extension
   * doesn't have to re-derive next actions (pln#393 stp_0859ea93).
   */
  workflow_hints?: string[];
  /** True when board was loaded via bclaw_context(kind="board_summary"). */
  summary?: boolean;
  /** Pre-computed counts populated in summary mode instead of full arrays. */
  _counts?: BoardSummaryCounts;
  /**
   * pln#559 — assignments in a terminal state within the recent window
   * (RECENTLY_TERMINAL_WINDOW_MS) rendered under "Recently terminal" so a
   * worker that died (faussement-expiré, silent_death, completed) doesn't
   * just vanish from the tree. The 2026-06-10 calibration: 3 false TTL
   * expirations would have been invisible without this list.
   */
  recently_terminal_assignments?: any[];
  /**
   * pln#559 — bclaw_dispatch_status payload keyed by assignment_id.
   * Evidence-based replacement for the administrative `status` field that
   * the 2026-06-10 incidents proved wrong 4× in one day. Carries verdict
   * (diagnosis.health), digest (commits_ahead/dirty_tracked/fs activity)
   * and the verbatim recommended_next_action for the tooltip.
   */
  dispatch_statuses?: Record<string, DispatchStatusLite>;
  /** pln#559 — active loops, rendered as their own node group in Live activity. */
  active_loops?: any[];
}

/**
 * pln#559 — lite mirror of src/core/dispatch-status.ts DispatchStatus so the
 * extension can consume the bclaw_dispatch_status structuredContent without
 * pulling the full server types (the extension package has no access to the
 * project's src/). Only the fields the tree actually reads are declared.
 */
interface DispatchStatusLite {
  diagnosis?: {
    health?: string;
    summary?: string;
    recommended_next_action?: string;
  };
  runtime?: {
    pid?: number;
    pid_alive?: boolean;
    last_fs_activity_ms?: number;
    commits_ahead?: number;
    dirty_tracked?: number;
    lane_result?: { status: string; summary: string };
    log_files?: {
      stdout?: { path: string; exists: boolean };
      stderr?: { path: string; exists: boolean };
    };
  };
  entities?: {
    assignment_id?: string;
    claim_id?: string;
    loop_id?: string;
    run_id?: string;
  };
}

/**
 * pln#559 — only assignments terminal within this window appear under
 * "Recently terminal". Long enough to catch a refresh cycle after the
 * sweep that buried the worker, short enough that the list doesn't grow
 * into a history view. 6h matches the operator session length the
 * 2026-06-10 incidents stretched across.
 */
const RECENTLY_TERMINAL_WINDOW_MS = 6 * 60 * 60 * 1000;

/** pln#559 — cap of dispatch_status calls per refresh (git execs aren't cheap on Windows). */
const DISPATCH_STATUS_BUDGET = 10;

interface ListedPlan {
  id: string;
  text?: string;
  priority?: string;
  assignee?: string;
  tags?: string[];
}

interface RegisteredAgent {
  agent_name: string;
  agent_id?: string;
  kind?: string;
}

type CanonicalEntity = 'plan' | 'claim' | 'assignment' | 'agent_run' | 'action' | 'candidate' | 'sequence' | 'trap' | 'runtime_note' | 'handoff';

interface SearchResultItem {
  id: string;
  section?: string;
  type?: string;
  text: string;
  score?: number;
}

// pln#558 step 5 — kept slightly above the default poll interval (30s). Equal
// TTL and poll forced a cold refetch on every cycle for every expanded
// section. The cache must outlive at least one full poll so the next refresh
// can return cached data while the background fetch runs.
const SECTION_CACHE_TTL_MS = 45_000;

function freshnessIcon(freshness: Freshness): vscode.ThemeIcon {
  switch (freshness) {
    case 'active': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
    case 'idle': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('editorWarning.foreground'));
    case 'stale': return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
  }
}

function activePlans(board: BoardData): any[] {
  return (board.active_plans ?? []).filter((plan: any) => plan.status !== 'done' && plan.status !== 'dropped');
}

function activeClaims(board: BoardData): any[] {
  // "active" means: held by an agent right now. Released/expired claims are
  // history and belong in System, not Live activity. The fetch already filters
  // but we filter again defensively so the section does not render stale
  // entries if the MCP layer ever loosens its filter.
  return (board.active_claims ?? []).filter((claim: any) => {
    const status = claim.status ?? 'active';
    return status === 'active';
  });
}

function activeAssignments(board: BoardData): any[] {
  return (board.active_assignments ?? []).filter((a: any) => {
    const status = a.status ?? 'active';
    // Any non-terminal state counts as "in flight" from a human's perspective.
    return status !== 'completed' && status !== 'expired' && status !== 'rerouted' && status !== 'cancelled';
  });
}

function activeRuns(board: BoardData): any[] {
  return (board.active_runs ?? []).filter((r: any) => {
    const status = r.status ?? 'active';
    return status !== 'completed' && status !== 'cancelled';
  });
}

function activeActions(board: BoardData): any[] {
  return (board.active_actions ?? []).filter((a: any) => {
    const status = a.status ?? 'pending';
    return status === 'pending' || status === 'in_progress';
  });
}

function visibleHandoffs(board: BoardData): any[] {
  return (board.open_handoffs ?? [])
    .filter((handoff: any) => handoff.status !== 'closed')
    .filter((handoff: any) => !handoff.text?.startsWith('Session sess_'));
}

function workingAgents(board: BoardData): any[] {
  return (board.other_agents ?? []).filter((agent: any) => agentFreshness(agent) === 'active');
}

function openSessions(board: BoardData): number {
  return (board.other_agents ?? []).filter((agent: any) => agent.has_open_session).length;
}

function planSortKey(plan: any): string {
  return String(plan.updated_at ?? plan.created_at ?? '');
}

function sortBacklogPlans(plans: any[]): any[] {
  const priorityRank = (priority?: string) => {
    switch (priority) {
      case 'high': return 0;
      case 'medium': return 1;
      case 'low': return 2;
      default: return 3;
    }
  };
  const statusRank = (status?: string) => status === 'in_progress' ? 0 : 1;

  return [...plans].sort((left, right) =>
    statusRank(left.status) - statusRank(right.status)
    || priorityRank(left.priority) - priorityRank(right.priority)
    || planSortKey(right).localeCompare(planSortKey(left))
    || String(left.id ?? '').localeCompare(String(right.id ?? '')));
}


const SECTION = {
  PROJECTS: 'projects',
  // Outcome sections (new hierarchy)
  ATTENTION: 'attention',
  IN_PROGRESS: 'in-progress',
  SPRINTS: 'sprints',
  BACKLOG: 'backlog',
  SYSTEM: 'system',
  // Entity sections (kept for legacy dispatch compatibility)
  AGENTS: 'agents',
  CANDIDATES: 'candidates',
  ACTIVITY: 'activity',
  PLANS: 'plans',
  CLAIMS: 'claims',
  ASSIGNMENTS: 'assignments',
  RUNS: 'runs',
  ACTIONS: 'actions',
  HANDOFFS: 'handoffs',
  SPRINT: 'sprint',
  TRAPS: 'traps',
  CROSS_PROJECT: 'cross-project',
} as const;

// pln#457: outcome sections rendered per project. Used by _fireChangedSections
// to iterate and diff per-section signatures. Entity sections are legacy
// dispatch views that aren't part of the default project layout, so they
// refresh lazily via getChildren() and don't need per-section diffing.
const REFRESHABLE_SECTION_IDS: readonly string[] = [
  SECTION.ATTENTION,
  SECTION.IN_PROGRESS,
  SECTION.SPRINTS,
  SECTION.BACKLOG,
  SECTION.SYSTEM,
];

// pln#560 slice3 — sections whose ENTIRE content is journal-driven (plans /
// traps / handoffs all reach the journal with payloads, trp_2a89ae97). In
// observerMode these render from the in-memory projection with zero MCP calls.
const JOURNAL_DRIVEN_SECTIONS: ReadonlySet<string> = new Set([
  SECTION.BACKLOG, SECTION.PLANS, SECTION.TRAPS, SECTION.HANDOFFS,
]);

// pln#560 completion — the registry/coordination families (claim, assignment,
// agent_run, action_required, candidate, sequence) are journaled with full
// post-images since pln#568, so their sections serve entity content from the
// projection too — but ONLY once the journal is authoritative for the registry
// (the registry_genesis backfill marker was ingested — see
// BoardObserver.registryAuthoritative). Before the marker, a partially-journaled
// store would under-render these sections (the trp#559 bug class, applied to
// content instead of counts), so they keep the MCP fetch. Non-journaled extras
// on the composite sections (workflow_hints, loops, dispatch_status evidence)
// stay best-effort MCP reads through the observer-flagged client.
// SYSTEM stays MCP either way: it mixes private/machine runtime_notes (never
// journaled — visibility boundary, dec_8705fb8e) and cross_project config.
const REGISTRY_JOURNAL_SECTIONS: ReadonlySet<string> = new Set([
  SECTION.ATTENTION, SECTION.IN_PROGRESS, SECTION.SPRINTS, SECTION.SPRINT,
  SECTION.CLAIMS, SECTION.ASSIGNMENTS, SECTION.RUNS, SECTION.ACTIONS, SECTION.CANDIDATES,
]);

const COMMAND = {
  RETRY_PROJECT_BOARD: 'brainclaw.retryProjectBoard',
} as const;

export class BrainclawBoardProvider implements vscode.TreeDataProvider<BrainclawTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BrainclawTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _workspaceRoot: string;
  private readonly _projects: BoardProject[];
  private readonly _projectIndex = new Map<string, BoardProject>();
  private readonly _rootProjectPath?: string;

  private readonly _watchers = new Map<string, fs.FSWatcher>();
  private readonly _projectBoards = new Map<string, BoardData | null>();
  private readonly _projectErrors = new Map<string, string>();
  private readonly _loadPromises = new Map<string, Promise<BoardData | null>>();
  private readonly _sectionBoards = new Map<string, SectionCacheEntry>();
  private readonly _sectionLoadPromises = new Map<string, Promise<BoardData | null>>();
  private readonly _loadingProjects = new Set<string>();
  private readonly _mcpClients = new Map<string, McpClient>();
  // Resolved brainclaw spawn plan per project (null = confirmed failure, so
  // we don't re-probe on every fetch). The parallel `_resolveErrors` map
  // holds the classified error message for failed cases so callers can
  // surface WHY resolution failed (trp#927 speaking-degradation fix).
  private readonly _resolvedPlans = new Map<string, BrainclawSpawnPlan | null>();
  private readonly _resolvingPlans = new Map<string, Promise<BrainclawSpawnPlan | undefined>>();
  private readonly _resolveErrors = new Map<string, string>();
  // Incremental refresh (pln#457):
  //   _sectionItems caches BrainclawTreeItem instances per section so that the
  //   same reference is returned from getChildren() across refreshes — that's
  //   what lets _onDidChangeTreeData.fire(sectionItem) resolve the node inside
  //   VS Code's tree and invalidate only that subtree.
  //   _sectionSignatures holds a digest of each section's rendered content;
  //   on refresh we fire only for sections whose signature actually changed.
  private readonly _sectionItems = new Map<string, BrainclawTreeItem>();
  private readonly _sectionSignatures = new Map<string, string>();
  private readonly _disposables: vscode.Disposable[] = [];

  private _workspaceBoard: BoardData | null = null;
  private _refreshTimer?: ReturnType<typeof setTimeout>;
  private _fileDecoRefresh?: () => void;
  private _statusUpdate?: (summary: BrainclawStatusSummary) => void;
  // pln#560 slice2 — per-project journal observers (created lazily when
  // observerMode is on). Each owns an in-memory projection + persisted cursor.
  private readonly _observers = new Map<string, BoardObserver>();
  private readonly _workspaceState?: CursorMemento;

  constructor(
    workspaceRoot: string,
    projects: BoardProject[],
    fileDecoRefresh?: () => void,
    statusUpdate?: (summary: BrainclawStatusSummary) => void,
    workspaceState?: CursorMemento,
  ) {
    this._workspaceRoot = this._normalizePath(workspaceRoot);
    this._projects = this._dedupeProjects(projects);
    this._fileDecoRefresh = fileDecoRefresh;
    this._statusUpdate = statusUpdate;
    this._workspaceState = workspaceState;
    for (const project of this._projects) {
      this._projectIndex.set(project.path, project);
    }
    this._rootProjectPath = this._projects.find((project) => project.path === this._workspaceRoot)?.path;

    this._disposables.push(vscode.commands.registerCommand(COMMAND.RETRY_PROJECT_BOARD, (itemOrPath?: BrainclawTreeItem | string) => {
      const projectPath = typeof itemOrPath === 'string' ? itemOrPath : itemOrPath?.projectPath;
      if (!projectPath) return;
      void this._loadBoardForProject(projectPath, true, true);
    }));

    setTimeout(() => {
      void this.refresh();
      this._syncWatches();
    }, 0);
  }

  public async refresh(): Promise<void> {
    await this._refreshBoards();
  }

  public syncWatches(): void {
    this._syncWatches();
  }

  /**
   * Expose the MCP client for a project so other consumers (e.g. the entity
   * preview content provider) can reuse the live, initialized connection
   * instead of spawning their own brainclaw process.
   */
  public getMcpClient(projectPath: string): Promise<McpClient | null> {
    const targetCwd = this._normalizePath(projectPath || this._rootProjectPath || this._workspaceRoot);
    return this._getMcpClient(targetCwd);
  }

  public async exec(command: string, cwd?: string): Promise<void> {
    const targetCwd = this._normalizePath(cwd ?? this._rootProjectPath ?? this._workspaceRoot);
    await this._execViaMcp(command, targetCwd);
  }

  /**
   * pln#559 step 4 — fallback resolver for `brainclaw.openWorktree`. When the
   * row carries no cached worktree_path (summary mode / older snapshot), look
   * the assignment up in the cached board and return its worktree_path. Best-
   * effort: returns undefined when the tree has no fix for this item.
   */
  public async resolveWorktreePath(item: BrainclawTreeItem): Promise<string | undefined> {
    if (!item.itemId || !item.projectPath) return undefined;
    const board = this._getBoardForPath(item.projectPath);
    if (!board) return undefined;
    const haystack = [
      ...(board.active_assignments ?? []),
      ...(board.recently_terminal_assignments ?? []),
      ...(board.active_claims ?? []),
      ...(board.active_runs ?? []),
    ];
    const hit = haystack.find((e: any) => e.id === item.itemId);
    return hit?.worktree_path;
  }

  /**
   * pln#559 step 4 — canonical log paths for an assignment-shaped row:
   * `<project>/.brainclaw/coordination/runtime/log/<asgn>.{stdout,stderr}.log`.
   * Reproduces the layout dispatch-status.ts:442 builds against, so the
   * triage shortcut works even when the live row never received a
   * dispatch_status payload (older brainclaw, or assignment outside the
   * DISPATCH_STATUS_BUDGET).
   */
  public async resolveCapturedLogPaths(item: BrainclawTreeItem): Promise<string[]> {
    if (!item.itemId || !item.projectPath) return [];
    // Assignments and runs both live under the same .brainclaw runtime path,
    // keyed by assignment_id. For a run-shaped item, look up the
    // assignment_id; otherwise the itemId IS the assignment_id.
    let assignmentId = item.itemId;
    const board = this._getBoardForPath(item.projectPath);
    if (board && item.contextValue === 'run') {
      const run = (board.active_runs ?? []).find((r: any) => r.id === item.itemId);
      if (run?.assignment_id) assignmentId = run.assignment_id;
    }
    const root = path.join(this._normalizePath(item.projectPath), '.brainclaw', 'coordination', 'runtime', 'log');
    return [
      path.join(root, `${assignmentId}.stdout.log`),
      path.join(root, `${assignmentId}.stderr.log`),
    ];
  }

  public async quickCapture(text: string): Promise<void> {
    const targetCwd = this._normalizePath(this._rootProjectPath ?? this._workspaceRoot);
    const client = await this._getMcpClient(targetCwd);
    if (!client) {
      vscode.window.showErrorMessage(this._noBclawMessage(targetCwd));
      return;
    }
    try {
      await client.callTool('bclaw_quick_capture', { text });
      await this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Brainclaw: ${message}`);
    }
  }

  public async dispatchWithPicker(): Promise<void> {
    const targetCwd = this._normalizePath(this._rootProjectPath ?? this._workspaceRoot);
    const client = await this._getMcpClient(targetCwd);
    if (!client) {
      vscode.window.showErrorMessage(this._noBclawMessage(targetCwd));
      return;
    }

    const plans = await this._findEntities<ListedPlan>(client, 'plan', { status: 'todo', limit: 50 });
    if (plans.length === 0) {
      vscode.window.showInformationMessage('No todo plans available to dispatch');
      return;
    }

    const items = plans.map((plan) => ({
      label: plan.text?.slice(0, 80) ?? plan.id,
      description: `${plan.priority ?? 'medium'} · ${plan.assignee ?? 'unassigned'}`,
      detail: plan.id,
      planId: plan.id,
      lane: this._extractLane(plan.tags),
    }));

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select plan to dispatch' });
    if (!picked) return;
    if (!picked.lane) {
      vscode.window.showErrorMessage(`Brainclaw: Could not determine lane for plan ${picked.planId}`);
      return;
    }

    try {
      const analysis = await client.callTool('bclaw_dispatch', { intent: 'analysis', lanes: [picked.lane] });
      const availableAgents = Array.isArray(analysis.available_agents) ? analysis.available_agents as string[] : [];
      if (availableAgents.length === 0) {
        vscode.window.showWarningMessage(`Brainclaw: no available agents for lane ${picked.lane}`);
        return;
      }

      const selectedAgent = await vscode.window.showQuickPick(
        availableAgents.map((agent) => ({ label: agent })),
        { placeHolder: `Dispatch ${picked.planId} to which agent?` },
      );
      if (!selectedAgent) return;

      await client.callTool('bclaw_dispatch', { intent: 'execute', lanes: [picked.lane], agents: [selectedAgent.label], maxAssignments: 1 });
      vscode.window.showInformationMessage(`Brainclaw: dispatched ${picked.planId} to ${selectedAgent.label}`);
      await this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Brainclaw: ${message}`);
    }
  }

  public async searchWithPicker(output: vscode.OutputChannel): Promise<void> {
    const targetCwd = this._normalizePath(this._rootProjectPath ?? this._workspaceRoot);
    const client = await this._getMcpClient(targetCwd);
    if (!client) {
      vscode.window.showErrorMessage(this._noBclawMessage(targetCwd));
      return;
    }

    const query = await vscode.window.showInputBox({
      prompt: 'Search Brainclaw memory',
      placeHolder: 'plan, claim, trap, decision...',
    });
    if (query === undefined) return;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      vscode.window.showWarningMessage('Brainclaw: enter a search query');
      return;
    }

    try {
      const result = await client.callTool('bclaw_search', { query: trimmedQuery, limit: 20 });
      const results = Array.isArray(result.results) ? result.results as SearchResultItem[] : [];
      if (results.length === 0) {
        vscode.window.showInformationMessage(`Brainclaw: no results for "${trimmedQuery}"`);
        return;
      }

      const picked = await vscode.window.showQuickPick(
        results.map((entry) => ({
          label: entry.text.slice(0, 80),
          description: `${entry.section ?? entry.type ?? 'memory'} · ${entry.id}`,
          detail: `score ${(entry.score ?? 0).toFixed(2)}`,
          result: entry,
        })),
        { placeHolder: `Search results for "${trimmedQuery}"` },
      );
      if (!picked) return;

      output.clear();
      output.appendLine(`Brainclaw Search: ${trimmedQuery}`);
      output.appendLine('');
      output.appendLine(`[${picked.result.id}] ${picked.result.section ?? picked.result.type ?? 'memory'}`);
      output.appendLine(picked.result.text);
      output.show(true);
      void vscode.commands.executeCommand('brainclaw.showBoard');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Brainclaw: ${message}`);
    }
  }

  public async runDoctor(output: vscode.OutputChannel): Promise<void> {
    const targetCwd = this._normalizePath(this._rootProjectPath ?? this._workspaceRoot);
    const client = await this._getMcpClient(targetCwd);
    if (!client) {
      vscode.window.showErrorMessage(this._noBclawMessage(targetCwd));
      return;
    }

    try {
      const result = await client.callTool('bclaw_doctor', {});
      const checks = Array.isArray(result.checks) ? result.checks as Array<Record<string, unknown>> : [];
      output.clear();
      output.appendLine('Brainclaw Doctor');
      output.appendLine('');
      output.appendLine(typeof result.ok === 'boolean'
        ? (result.ok ? 'Status: OK' : 'Status: issues detected')
        : 'Status: unknown');
      if (typeof result.summary === 'string' && result.summary.trim()) {
        output.appendLine(result.summary);
      }
      if (checks.length > 0) {
        output.appendLine('');
        for (const check of checks) {
          output.appendLine(`[${String(check.name ?? 'check')}] ${String(check.status ?? 'unknown')}: ${String(check.message ?? '')}`);
        }
      }
      output.show(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Brainclaw: ${message}`);
    }
  }

  private async _execViaMcp(command: string, targetCwd: string): Promise<void> {
    const client = await this._getMcpClient(targetCwd);
    if (!client) {
      vscode.window.showErrorMessage(this._noBclawMessage(targetCwd));
      return;
    }

    try {
      // Map legacy CLI command strings to MCP tool calls
      const [tool, args] = this._mapCommandToMcpTool(command);
      await client.callTool(tool, args);
      await this.refresh();
      // Claim-mutating operations invalidate the file-decoration state; refresh
      // lock icons synchronously with the board so operators don't see stale
      // locks after release/claim (pln#393 stp_9010b323).
      if (tool === 'bclaw_release_claim' || tool === 'bclaw_claim') {
        this._fileDecoRefresh?.();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Brainclaw: ${message}`);
    }
  }

  private _mapCommandToMcpTool(command: string): [string, Record<string, unknown>] {
    const parts = command.trim().split(/\s+/);
    // "accept <id>"
    if (parts[0] === 'accept' && parts[1]) {
      return ['bclaw_transition', { entity: 'candidate', id: parts[1], to: 'accepted' }];
    }
    // "reject <id>"
    if (parts[0] === 'reject' && parts[1]) {
      return ['bclaw_transition', { entity: 'candidate', id: parts[1], to: 'rejected' }];
    }
    // "claim release <id>"
    if (parts[0] === 'claim' && parts[1] === 'release' && parts[2]) {
      return ['bclaw_release_claim', { id: parts[2] }];
    }
    // "approve-action <id>"
    if (parts[0] === 'approve-action' && parts[1]) {
      return ['bclaw_assignment_action', { action_id: parts[1], outcome: 'resolved' }];
    }
    // "reject-action <id>"
    if (parts[0] === 'reject-action' && parts[1]) {
      return ['bclaw_assignment_action', { action_id: parts[1], outcome: 'rejected' }];
    }
    throw new Error(`Unsupported command: ${command}`);
  }

  public async approveAction(actionId: string, projectPath?: string): Promise<void> {
    const cwd = this._normalizePath(projectPath ?? this._rootProjectPath ?? this._workspaceRoot);
    await this._execViaMcp('approve-action ' + actionId, cwd);
  }

  public async rejectAction(actionId: string, projectPath?: string): Promise<void> {
    const cwd = this._normalizePath(projectPath ?? this._rootProjectPath ?? this._workspaceRoot);
    await this._execViaMcp('reject-action ' + actionId, cwd);
  }

  public async dispatchPlan(planId: string, projectPath?: string): Promise<void> {
    const cwd = this._normalizePath(projectPath ?? this._rootProjectPath ?? this._workspaceRoot);
    const client = await this._getMcpClient(cwd);
    if (!client) {
      vscode.window.showErrorMessage(this._noBclawMessage(cwd));
      return;
    }
    const board = this._workspaceBoard;
    const plans = board ? activePlans(board) : [];
    const plan = plans.find((p: any) => p.id === planId);
    if (!plan || !plan.lane) {
      vscode.window.showErrorMessage(`Brainclaw: Could not determine lane for plan ${planId}`);
      return;
    }
    try {
      await client.callTool('bclaw_dispatch', { intent: 'execute', lanes: [plan.lane] });
      await this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Brainclaw: ${message}`);
    }
  }

  public async releaseClaim(claimId: string, projectPath?: string): Promise<void> {
    const cwd = this._normalizePath(projectPath ?? this._rootProjectPath ?? this._workspaceRoot);
    await this._execViaMcp('claim release ' + claimId, cwd);
  }

  /**
   * Claim a scope via MCP. Replaces the previous fire-and-forget CLI exec()
   * so errors surface to the operator and the board + lock icons refresh
   * in sync (pln#393 stp_9010b323).
   */
  public async claimScope(scope: string, description: string, projectPath?: string): Promise<void> {
    const cwd = this._normalizePath(projectPath ?? this._rootProjectPath ?? this._workspaceRoot);
    const client = await this._getMcpClient(cwd);
    if (!client) {
      vscode.window.showErrorMessage(this._noBclawMessage(cwd));
      return;
    }
    try {
      await client.callTool('bclaw_claim', { scope, description });
      await this.refresh();
      this._fileDecoRefresh?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Brainclaw: ${message}`);
    }
  }

  /**
   * Add a trap via MCP. Replaces the previous fire-and-forget CLI exec().
   */
  public async addTrap(text: string, scopePath: string, projectPath?: string): Promise<void> {
    const cwd = this._normalizePath(projectPath ?? this._rootProjectPath ?? this._workspaceRoot);
    const client = await this._getMcpClient(cwd);
    if (!client) {
      vscode.window.showErrorMessage(this._noBclawMessage(cwd));
      return;
    }
    try {
      await client.callTool('bclaw_create', {
        entity: 'trap',
        data: { text, path: scopePath, severity: 'medium' },
      });
      await this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Brainclaw: ${message}`);
    }
  }

  /**
   * Search memory for a scope and render the results in an output channel.
   * Replaces the previous stub (pln#393 stp_9010b323).
   */
  public async viewMemoryForScope(scope: string, output: vscode.OutputChannel, projectPath?: string): Promise<void> {
    const cwd = this._normalizePath(projectPath ?? this._rootProjectPath ?? this._workspaceRoot);
    const client = await this._getMcpClient(cwd);
    if (!client) {
      vscode.window.showErrorMessage(this._noBclawMessage(cwd));
      return;
    }
    output.clear();
    output.appendLine(`Brainclaw memory for scope: ${scope}`);
    output.appendLine('');
    try {
      const result = await client.callTool('bclaw_search', { query: scope, limit: 20 });
      const results = Array.isArray(result.results) ? result.results as SearchResultItem[] : [];
      if (results.length === 0) {
        output.appendLine('(no matches)');
      } else {
        for (const entry of results) {
          const kind = entry.section ?? entry.type ?? 'memory';
          output.appendLine(`[${entry.id}] ${kind} · score ${(entry.score ?? 0).toFixed(2)}`);
          output.appendLine(`  ${entry.text}`);
          output.appendLine('');
        }
      }
      output.show(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Error: ${message}`);
      output.show(true);
      vscode.window.showErrorMessage(`Brainclaw: ${message}`);
    }
  }

  private _normalizePath(targetPath: string): string {
    return path.resolve(targetPath);
  }

  private _dedupeProjects(projects: BoardProject[]): BoardProject[] {
    const deduped = new Map<string, BoardProject>();
    for (const project of projects) {
      const normalizedPath = this._normalizePath(project.path);
      deduped.set(normalizedPath, {
        ...project,
        path: normalizedPath,
        isWorkspaceRoot: normalizedPath === this._workspaceRoot || project.isWorkspaceRoot,
      });
    }
    return [...deduped.values()].sort((left, right) => {
      if (left.isWorkspaceRoot !== right.isWorkspaceRoot) {
        return left.isWorkspaceRoot ? -1 : 1;
      }
      return left.relativePath.localeCompare(right.relativePath) || left.name.localeCompare(right.name);
    });
  }

  private async _refreshBoards(): Promise<void> {
    const loads: Array<Promise<BoardData | null>> = [];
    if (this._rootProjectPath) {
      loads.push(this._loadBoard(true));
    } else {
      this._workspaceBoard = null;
    }

    for (const project of this._projects) {
      if (project.path === this._rootProjectPath) continue;
      loads.push(this._loadBoardForProject(project.path, true));
    }

    if (loads.length > 0) {
      await Promise.allSettled(loads);
    }

    this._statusUpdate?.(this._aggregateStatusSummary());
    // pln#457: targeted fire. Diff each section's signature against the
    // previous one and fire only for sections that actually changed. Falls
    // back to a root-level fire when projects were added/removed, since the
    // tree's top-level shape cannot be reconciled via stable leaf IDs alone.
    this._fireChangedSections();
  }

  private _fireChangedSections(): void {
    // Use the per-section signature as a gate: if NO section changed we skip
    // firing entirely (VS Code keeps rendering the current state, no wasted
    // getChildren calls). If any section changed we fire the root once —
    // stable leaf IDs + the cached section item instances let VS Code
    // reconcile every level without destroying/recreating nodes, so there is
    // no visible flash even though the fire is root-level. Going finer-grained
    // (fire(sectionItem) only) would leave the parent project-summary label
    // stale ("N plans · N claims" is on the project row, not the section);
    // fixing that would require caching project item instances too and firing
    // both — more moving parts for marginal gain.
    const scanned = new Set<string>();
    let anyChanged = false;
    let firstRender = this._sectionSignatures.size === 0;

    const scan = (projectPath: string, board: BoardData | null): void => {
      if (!board) return;
      const normalizedPath = this._normalizePath(projectPath);
      for (const sectionId of REFRESHABLE_SECTION_IDS) {
        const key = this._sectionCacheKey(normalizedPath, sectionId);
        const signature = this._computeSectionSignature(sectionId, board, normalizedPath);
        scanned.add(key);
        const prev = this._sectionSignatures.get(key);
        if (prev !== signature) {
          this._sectionSignatures.set(key, signature);
          anyChanged = true;
        }
      }
    };

    if (this._rootProjectPath && this._projects.length === 0 && this._workspaceBoard) {
      scan(this._rootProjectPath, this._workspaceBoard);
    }
    for (const project of this._projects) {
      scan(project.path, this._getBoardForPath(project.path) ?? null);
    }

    // Evict signature + section-item entries for sections that dropped out of
    // scope (e.g. a project removed from the workspace) so caches don't grow
    // unboundedly.
    for (const key of [...this._sectionSignatures.keys()]) {
      if (!scanned.has(key)) {
        this._sectionSignatures.delete(key);
        this._sectionItems.delete(key);
        anyChanged = true;
      }
    }

    if (firstRender || anyChanged) {
      this._onDidChangeTreeData.fire();
    }
  }

  private _computeSectionSignature(sectionId: string, board: BoardData, projectPath: string): string {
    // Hash the fields that actually drive section rendering. Missing fields
    // collapse to empty strings so a board summary (no active_plans array)
    // and a full board (populated array) don't trigger spurious refreshes
    // when counts happen to agree.
    const sectionBoard = this._getSectionBoard(projectPath, sectionId) ?? board;
    const join = (parts: string[]): string => parts.join('|');

    switch (sectionId) {
      case SECTION.ATTENTION: {
        const actions = activeActions(sectionBoard).map((a: any) => `act:${a.id}:${a.status}:${a.updated_at ?? a.created_at}`);
        const cands = (sectionBoard.pending_candidates ?? [])
          .filter((c: any) => !isAutoCandidate(c))
          .map((c: any) => `cd:${c.id}:${c.created_at}:${c.overdue ? 1 : 0}`);
        const blocked = activeAssignments(sectionBoard)
          .filter((a: any) => a.status === 'blocked')
          .map((a: any) => `ba:${a.id}:${a.last_heartbeat_at}`);
        const stale = activeRuns(sectionBoard)
          .filter((r: any) => r.status === 'blocked' || r.status === 'waiting_input' || r.status === 'failed')
          .map((r: any) => `sr:${r.id}:${r.status}:${r.last_event_at}`);
        const hints = (sectionBoard.workflow_hints ?? []).slice();
        return [join(actions), join(cands), join(blocked), join(stale), join(hints)].join('||');
      }
      case SECTION.IN_PROGRESS: {
        const ds = sectionBoard.dispatch_statuses ?? {};
        // pln#559 — include the evidence digest in the signature so the tree
        // refreshes when health flips (e.g. healthy → silent_death) even if
        // the administrative status hasn't changed.
        const evidenceKey = (id: string): string => {
          const d = ds[id];
          if (!d?.diagnosis) return '-';
          const rt = d.runtime ?? {};
          return `${d.diagnosis.health ?? '-'}:${rt.commits_ahead ?? '-'}:${rt.dirty_tracked ?? '-'}:${rt.pid_alive ?? '-'}`;
        };
        const claims = activeClaims(sectionBoard).map((c: any) => `cl:${c.id}:${c.agent}:${c.scope}:${c.updated_at ?? c.created_at}`);
        const asgs = activeAssignments(sectionBoard)
          .filter((a: any) => a.status !== 'blocked')
          .map((a: any) => `as:${a.id}:${a.status}:${a.last_heartbeat_at}:${evidenceKey(a.id)}`);
        const runs = activeRuns(sectionBoard)
          .filter((r: any) => r.status !== 'blocked' && r.status !== 'waiting_input' && r.status !== 'failed')
          .map((r: any) => `ru:${r.id}:${r.status}:${r.attempt_index}:${r.last_event_at}`);
        const terminal = (sectionBoard.recently_terminal_assignments ?? [])
          .map((a: any) => `at:${a.id}:${a.status}:${a.updated_at}:${evidenceKey(a.id)}`);
        const loops = (sectionBoard.active_loops ?? [])
          .map((l: any) => `lp:${l.id}:${l.status}:${l.current_phase}:${l.iteration_count ?? 0}`);
        return [join(claims), join(asgs), join(runs), join(terminal), join(loops)].join('||');
      }
      case SECTION.SPRINTS: {
        const items = (sectionBoard.active_sequence?.items ?? []) as any[];
        const fields = items.map((i: any) => `sp:${i.rank}:${i.planId}:${i.plan_status}:${String(i.plan_text ?? '').slice(0, 80)}`);
        return join(fields);
      }
      case SECTION.BACKLOG: {
        const plans = activePlans(sectionBoard)
          .filter((p: any) => p.status === 'in_progress' || p.status === 'todo')
          .map((p: any) => `pl:${p.id}:${p.status}:${p.priority}:${p.updated_at ?? p.created_at}:${p.steps?.length ?? 0}:${p.steps ? p.steps.filter((s: any) => s.status === 'done').length : 0}`);
        const traps = (sectionBoard.known_traps ?? [])
          .filter((t: any) => (t.status ?? 'active') === 'active')
          .map((t: any) => `tp:${t.id}:${t.severity}:${t.updated_at ?? t.created_at}`);
        return [join(plans), join(traps)].join('||');
      }
      case SECTION.SYSTEM: {
        const agents = (sectionBoard.other_agents ?? []).map((a: any) => `ag:${a.id ?? a.name}:${a.last_active}:${a.claim_count ?? 0}:${a.has_open_session ? 1 : 0}`);
        const auto = (sectionBoard.pending_candidates ?? [])
          .filter((c: any) => isAutoCandidate(c))
          .map((c: any) => `ac:${c.id}:${c.created_at}`);
        const notes = (sectionBoard.runtime_notes ?? []).map((n: any) => `nt:${n.id}:${n.created_at}`);
        const handoffs = visibleHandoffs(sectionBoard).map((h: any) => `hf:${h.id}:${h.updated_at ?? h.created_at}`);
        const linked = (sectionBoard.linked_projects ?? []).map((l: any) => `lp:${l.name}:${l.active_plans}:${l.active_claims}:${l.available ? 1 : 0}`);
        const signals = (sectionBoard.incoming_signals ?? []).map((s: any) => `sg:${s.id}:${s.created_at}`);
        return [join(agents), join(auto), join(notes), join(handoffs), join(linked), join(signals)].join('||');
      }
      default: return '';
    }
  }

  private _debouncedRefresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => { void this.refresh(); }, 500);
  }

  dispose(): void {
    for (const watcher of this._watchers.values()) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    this._watchers.clear();
    for (const client of this._mcpClients.values()) {
      client.dispose();
    }
    this._mcpClients.clear();
    this._observers.clear();
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
  }

  /** pln#560 slice2 — observerMode gate. Off by default; needs workspaceState
   *  for the cursor (observer-protocol §3), so absent state disables it too. */
  private _observerEnabled(): boolean {
    return this._workspaceState !== undefined
      && vscode.workspace.getConfiguration('brainclaw').get<boolean>('observerMode', false) === true;
  }

  /** Lazily create the per-project journal observer. `projectId` keys the
   *  cursor (the board_summary project_id, else the normalized path). */
  private _getObserver(projectPath: string, projectId: string): BoardObserver | undefined {
    if (!this._workspaceState) return undefined;
    const normalizedPath = this._normalizePath(projectPath);
    let observer = this._observers.get(normalizedPath);
    if (!observer) {
      const eventsDir = path.join(normalizedPath, '.brainclaw', 'events');
      observer = new BoardObserver(eventsDir, projectId || normalizedPath, this._workspaceState);
      this._observers.set(normalizedPath, observer);
    }
    return observer;
  }

  private async _getMcpClient(projectPath: string): Promise<McpClient | null> {
    const normalizedPath = this._normalizePath(projectPath);
    const existing = this._mcpClients.get(normalizedPath);
    if (existing) return existing;

    const plan = await this._resolvePlan(normalizedPath);
    if (!plan) return null;

    const client = new McpClient(normalizedPath, plan);
    this._mcpClients.set(normalizedPath, client);
    return client;
  }

  private async _resolvePlan(cwd: string): Promise<BrainclawSpawnPlan | undefined> {
    const normalizedPath = this._normalizePath(cwd);
    if (this._resolvedPlans.has(normalizedPath)) {
      const cached = this._resolvedPlans.get(normalizedPath);
      return cached ?? undefined;
    }

    const pending = this._resolvingPlans.get(normalizedPath);
    if (pending) return pending;

    const resolvePromise = resolveBrainclawSpawnPlan(normalizedPath)
      .then((result: ResolveResult) => {
        if (result.ok) {
          this._resolvedPlans.set(normalizedPath, result.plan);
          this._resolveErrors.delete(normalizedPath);
          return result.plan;
        }
        this._resolvedPlans.set(normalizedPath, null);
        this._resolveErrors.set(normalizedPath, result.error);
        return undefined;
      })
      .finally(() => {
        this._resolvingPlans.delete(normalizedPath);
      });

    this._resolvingPlans.set(normalizedPath, resolvePromise);
    return resolvePromise;
  }

  /**
   * Speaking-degradation surface (trp#927 fix): callers that got `null` from
   * `_getMcpClient` (or the public `getMcpClient`) can look up the classified
   * reason resolution failed — listing every candidate the resolver tried and
   * why each one failed. Returns undefined if resolution has not been
   * attempted yet, or succeeded.
   */
  public getResolveError(projectPath: string): string | undefined {
    return this._resolveErrors.get(this._normalizePath(projectPath));
  }

  /**
   * Build the message shown to the user when no MCP client could be created.
   * If the resolver classified WHY, we include that; otherwise the legacy
   * short message.
   */
  private _noBclawMessage(projectPath: string): string {
    const detail = this.getResolveError(projectPath);
    return detail ? `Brainclaw: ${detail}` : 'Brainclaw: no brainclaw command found';
  }

  private _startWatches(): void {
    for (const project of this._projects) {
      this._startWatch(project.path);
    }
  }

  private _syncWatches(): void {
    if (!this._observerEnabled()) {
      for (const [key, watcher] of [...this._watchers.entries()]) {
        if (!key.endsWith('::events')) continue;
        try { watcher.close(); } catch { /* ignore */ }
        this._watchers.delete(key);
      }
    }
    this._startWatches();
  }

  private _startWatch(projectPath: string): void {
    const normalizedPath = this._normalizePath(projectPath);

    const brainclawDir = path.join(normalizedPath, '.brainclaw');
    if (!fs.existsSync(brainclawDir)) return;

    if (!this._watchers.has(normalizedPath)) {
      try {
        const watcher = fs.watch(brainclawDir, (_eventType, filename) => {
          const name = filename ? String(filename) : '';
          if (name === 'events' && this._observerEnabled()) {
            this._clearJournalDrivenSectionCache(normalizedPath);
            this._syncWatches();
            this._debouncedRefresh();
            return;
          }
          if (name === 'events.jsonl' || name.endsWith('events.jsonl')) {
            this._debouncedRefresh();
          }
        });
        watcher.on('error', () => {
          this._watchers.delete(normalizedPath);
        });
        watcher.on('close', () => {
          this._watchers.delete(normalizedPath);
        });
        this._watchers.set(normalizedPath, watcher);
      } catch {
        // Ignore watch startup failures for individual projects.
      }
    }

    // pln#560 slice2 — in observerMode also watch the v2 journal directory
    // (.brainclaw/events) for segment/meta growth; that growth signal is what
    // drives the projection tail + section refresh (observer-protocol §4),
    // replacing the polling timer. The .brainclaw watch above is non-recursive
    // and lives one level up, so the events/ subdir needs its own watch.
    if (this._observerEnabled()) {
      const eventsDir = path.join(normalizedPath, '.brainclaw', 'events');
      const eventsKey = `${normalizedPath}::events`;
      if (!this._watchers.has(eventsKey) && fs.existsSync(eventsDir)) {
        try {
          const evWatcher = fs.watch(eventsDir, (_eventType, filename) => {
            const name = filename ? String(filename) : '';
            if (name.endsWith('.jsonl') || name === 'meta.json') {
              this._clearJournalDrivenSectionCache(normalizedPath);
              this._debouncedRefresh();
            }
          });
          evWatcher.on('error', () => { this._watchers.delete(eventsKey); });
          evWatcher.on('close', () => { this._watchers.delete(eventsKey); });
          this._watchers.set(eventsKey, evWatcher);
        } catch {
          // Ignore — degrade to the .brainclaw watch + manual refresh.
        }
      }
    }
  }

  private async _runAgentBoard(projectPath: string): Promise<BoardData> {
    const client = await this._getMcpClient(projectPath);
    if (!client) {
      throw new Error(`No brainclaw command found for ${projectPath}`);
    }

    // Use the lightweight board summary through the v1 facade for activation polling.
    const raw = await client.callTool('bclaw_context', { kind: 'board_summary' }) as Record<string, any>;
    const plans = (raw['plans'] as Record<string, number> | undefined) ?? {};
    const sequences = (raw['sequences'] as Record<string, unknown> | undefined) ?? {};
    const activeSequenceName = typeof sequences['active_name'] === 'string' ? sequences['active_name'] as string : undefined;

    // board_summary is the lock-free seed (observer-protocol §6.1, pln#558). It
    // provides the degraded-family counts the journal cannot today (claims,
    // assignments, runs, the attention badge, agents, sessions) AND the plan
    // count fallback for when the journal is off/absent (§9).
    const seed: SeedCounts = {
      plans: (plans['in_progress'] ?? 0) + (plans['todo'] ?? 0),
      claims: (raw['in_progress'] as number | undefined) ?? 0,
      assignments: 0,
      runs: 0,
      // pln#559 step 3 — composite attention_required (pending actions +
      // non-auto candidates + blocked + stale runs) = what the Attention header shows.
      actions: (raw['attention_required'] as number | undefined) ?? 0,
      agents: (raw['agents'] as number | undefined) ?? 0,
      sessions: (raw['sessions'] as number | undefined) ?? 0,
      failedRuns: ((raw['attention_breakdown'] as any) ?? {}).stale_runs ?? 0,
    };

    // pln#560 slice2 — in observerMode, tail the journal and merge: `plans` comes
    // from the (journal-driven) projection, everything else from the lock-free
    // seed (trp_2a89ae97). When the journal dir is absent (journal off / not
    // migrated, §9) the projection is empty, so fall back to the seed plan count
    // rather than render 0. Off mode keeps the pure board_summary counts.
    let counts: BoardSummaryCounts;
    if (this._observerEnabled()) {
      const observer = this._getObserver(projectPath, (raw['project_id'] as string | undefined) ?? '');
      if (observer) {
        observer.ingest();
        const journalActive = fs.existsSync(path.join(this._normalizePath(projectPath), '.brainclaw', 'events'));
        // pln#568 slice 3 — once the journal carries the registry_genesis cutover
        // marker, the registry/coordination counts (claims/assignments/runs/
        // actions, the attention badge) come from the journal instead of the MCP
        // seed. Until then mergeCounts keeps them seed-backed (no badge regression).
        counts = mergeCounts(observer.counts(), seed, journalActive, observer.registryAuthoritative());
      } else {
        counts = { ...seed, failedRuns: seed.failedRuns ?? 0 };
      }
    } else {
      counts = { ...seed, failedRuns: seed.failedRuns ?? 0 };
    }

    return {
      active_plans: [],
      active_claims: [],
      active_assignments: [],
      active_runs: [],
      active_actions: [],
      open_handoffs: [],
      runtime_notes: [],
      other_agents: [],
      active_sequence: activeSequenceName ? { name: activeSequenceName, status: 'active', items: [] } : undefined,
      summary: true,
      _counts: counts,
    };
  }

  private async _loadBoard(force = false): Promise<BoardData | null> {
    if (!this._rootProjectPath) {
      this._workspaceBoard = null;
      return null;
    }

    const board = await this._requestBoardLoad(this._rootProjectPath, force);
    this._workspaceBoard = board;
    return board;
  }

  private async _loadBoardForProject(projectPath: string, force = false, notify = false): Promise<BoardData | null> {
    const normalizedPath = this._normalizePath(projectPath);
    if (normalizedPath === this._rootProjectPath) {
      const board = await this._loadBoard(force);
      if (notify) this._onDidChangeTreeData.fire();
      return board;
    }

    const board = await this._requestBoardLoad(normalizedPath, force);
    if (notify) this._onDidChangeTreeData.fire();
    return board;
  }

  private _requestBoardLoad(projectPath: string, force = false): Promise<BoardData | null> {
    const normalizedPath = this._normalizePath(projectPath);
    const existingBoard = this._projectBoards.get(normalizedPath);
    if (!force && existingBoard && !this._projectErrors.has(normalizedPath)) {
      return Promise.resolve(existingBoard);
    }

    const pending = this._loadPromises.get(normalizedPath);
    if (pending) return pending;

    this._loadingProjects.add(normalizedPath);
    const load = this._runAgentBoard(normalizedPath)
      .then((board) => {
        this._projectBoards.set(normalizedPath, board);
        this._projectErrors.delete(normalizedPath);
        // Keep section cache intact so expanded sections don't collapse to
        // "Loading..." on refresh. Each section has its own TTL and refetches
        // itself lazily on next expand. See pln#453 (refresh flicker).
        if (normalizedPath === this._rootProjectPath) {
          this._workspaceBoard = board;
        }
        return board;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this._projectBoards.delete(normalizedPath);
        this._projectErrors.set(normalizedPath, message);
        // Preserve section cache on error too — stale data is better than a
        // blank tree for a transient failure.
        if (normalizedPath === this._rootProjectPath) {
          this._workspaceBoard = null;
        }
        return null;
      })
      .finally(() => {
        this._loadingProjects.delete(normalizedPath);
        this._loadPromises.delete(normalizedPath);
      });

    this._loadPromises.set(normalizedPath, load);
    return load;
  }

  private _getProject(projectPath?: string): BoardProject | undefined {
    if (!projectPath) return undefined;
    return this._projectIndex.get(this._normalizePath(projectPath));
  }

  private _getBoardForPath(projectPath?: string): BoardData | null {
    if (!projectPath) return null;
    const normalizedPath = this._normalizePath(projectPath);
    if (normalizedPath === this._rootProjectPath) {
      return this._workspaceBoard;
    }
    return this._projectBoards.get(normalizedPath) ?? null;
  }

  private _projectSummary(board: BoardData): BoardSummaryCounts {
    if (board.summary && board._counts) {
      return board._counts;
    }
    return {
      plans: activePlans(board).length,
      claims: activeClaims(board).length,
      assignments: activeAssignments(board).length,
      runs: activeRuns(board).length,
      actions: activeActions(board).length,
      agents: workingAgents(board).length,
      sessions: openSessions(board),
      failedRuns: activeRuns(board).filter((r: any) => r.status === 'failed').length,
    };
  }

  private _aggregateStatusSummary(): BrainclawStatusSummary {
    const total: BrainclawStatusSummary = {
      plans: 0,
      claims: 0,
      assignments: 0,
      runs: 0,
      actions: 0,
      agents: 0,
      sessions: 0,
      failedRuns: 0,
    };

    const boards: BoardData[] = [];
    if (this._projects.length > 0) {
      for (const project of this._projects) {
        const board = this._getBoardForPath(project.path);
        if (board) boards.push(board);
      }
    } else if (this._workspaceBoard) {
      boards.push(this._workspaceBoard);
    }

    for (const board of boards) {
      const summary = this._projectSummary(board);
      total.plans += summary.plans;
      total.claims += summary.claims;
      total.assignments += summary.assignments;
      total.runs += summary.runs;
      total.actions += summary.actions;
      total.agents += summary.agents;
      total.sessions += summary.sessions;
      total.failedRuns = (total.failedRuns ?? 0) + (summary.failedRuns ?? 0);
    }

    return total;
  }

  getTreeItem(element: BrainclawTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BrainclawTreeItem): Promise<BrainclawTreeItem[]> {
    if (!element) {
      return this._buildSections();
    }

    if (element.nodeType === 'section' && element.sectionId === SECTION.PROJECTS) {
      return this._buildProjects();
    }

    if (element.nodeType === 'project' && element.projectPath) {
      return this._buildProjectChildren(element.projectPath);
    }

    if (element.nodeType === 'section' && element.sectionId && element.projectPath) {
      const board = this._getBoardForPath(element.projectPath);
      const normalizedPath = this._normalizePath(element.projectPath);
      const cachedSectionEntry = this._getSectionCacheEntry(normalizedPath, element.sectionId);
      if (cachedSectionEntry?.board) {
        return this._buildSectionChildren(element.sectionId, cachedSectionEntry.board, normalizedPath);
      }
      if (cachedSectionEntry?.error) {
        return [new BrainclawTreeItem(
          'Section unavailable',
          vscode.TreeItemCollapsibleState.None,
          this._truncate(cachedSectionEntry.error, 120),
          new vscode.ThemeIcon('error'),
        )];
      }

      const sectionKey = this._sectionCacheKey(normalizedPath, element.sectionId);
      if (!this._sectionLoadPromises.has(sectionKey)) {
        void this._loadSectionBoard(normalizedPath, element.sectionId);
      }

      if (!board) {
        if (!this._loadingProjects.has(normalizedPath)) {
          void this._loadBoardForProject(element.projectPath, false, true);
        }
      }

      return [this._loadingItem('Loading...')];
    }

    return [];
  }

  private _buildSections(): BrainclawTreeItem[] {
    const sections: BrainclawTreeItem[] = [];

    if (this._projects.length > 0) {
      sections.push(new BrainclawTreeItem(
        `Projects (${this._projects.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
        undefined,
        new vscode.ThemeIcon('folder-library'),
        'Brainclaw projects discovered in this workspace',
        undefined,
        undefined,
        undefined,
        SECTION.PROJECTS,
        'section',
        'section:projects',
      ));
    }

    // When multi-project view is active, don't duplicate root project sections at top level
    // They are already visible by expanding the root project under Projects
    if (this._projects.length === 0 && this._workspaceBoard && this._rootProjectPath) {
      sections.push(...this._buildBoardSections(this._workspaceBoard, this._rootProjectPath, true));
    }

    if (sections.length === 0) {
      sections.push(new BrainclawTreeItem(
        'No Brainclaw projects found in this workspace',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        new vscode.ThemeIcon('info'),
      ));
    }

    return sections;
  }

  private _buildProjects(): BrainclawTreeItem[] {
    if (this._projects.length === 0) {
      return [new BrainclawTreeItem('No projects discovered', vscode.TreeItemCollapsibleState.None)];
    }

    return this._projects.map((project) => {
      const board = this._getBoardForPath(project.path);
      const normalizedPath = this._normalizePath(project.path);

      if (!board && !this._loadingProjects.has(normalizedPath) && !this._projectErrors.has(normalizedPath)) {
        void this._loadBoardForProject(project.path, false, true);
      }

      let description = 'Loading summary...';
      let tooltip = `Project: ${project.name}\nPath: ${project.path}`;

      if (project.relativePath && project.relativePath !== '.') {
        tooltip += `\nRelative path: ${project.relativePath}`;
      } else if (project.isWorkspaceRoot) {
        tooltip += '\nWorkspace root project';
      }

      if (board) {
        const summary = this._projectSummary(board);
        if (board.summary) {
          description = `${summary.plans} plans · ${summary.claims} claims · ${summary.actions} attention · ${summary.agents} agents · ${summary.sessions} sessions`;
          tooltip += `\nPlans: ${summary.plans}\nClaims in progress: ${summary.claims}\nAttention required: ${summary.actions}\nAgents: ${summary.agents}\nOpen sessions: ${summary.sessions}`;
        } else {
          description = `${summary.plans} plans · ${summary.claims} claims · ${summary.assignments} assignments · ${summary.runs} runs · ${summary.actions} actions · ${summary.agents} agents · ${summary.sessions} sessions`;
          tooltip += `\nActive plans: ${summary.plans}\nActive claims: ${summary.claims}\nActive assignments: ${summary.assignments}\nActive runs: ${summary.runs}\nPending actions: ${summary.actions}\nAgents working: ${summary.agents}\nOpen sessions: ${summary.sessions}`;
        }
      } else if (this._projectErrors.has(normalizedPath)) {
        description = 'Board unavailable';
        tooltip += `\nError: ${this._projectErrors.get(normalizedPath)}`;
      }

      return new BrainclawTreeItem(
        project.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        description,
        new vscode.ThemeIcon(project.isWorkspaceRoot ? 'home' : 'repo'),
        tooltip,
        undefined,
        undefined,
        project.path,
        undefined,
        'project',
        `project:${project.path}`,
      );
    });
  }

  private async _buildProjectChildren(projectPath: string): Promise<BrainclawTreeItem[]> {
    const normalizedPath = this._normalizePath(projectPath);
    let board = this._getBoardForPath(normalizedPath);

    if (!board && !this._loadingProjects.has(normalizedPath)) {
      board = await this._loadBoardForProject(normalizedPath, false, true);
    }

    if (!board) {
      const error = this._projectErrors.get(normalizedPath);
      if (error) {
        const project = this._getProject(normalizedPath);
        const truncated = this._truncate(error, 200);
        const tooltip = `Board unavailable for ${project?.name ?? 'project'}\n${truncated}\n\nRight-click to Retry.`;
        const unavailableNode = new BrainclawTreeItem(
          'Board unavailable',
          vscode.TreeItemCollapsibleState.None,
          truncated,
          new vscode.ThemeIcon('error'),
          tooltip,
          'projectError',
          undefined,
          normalizedPath,
        );
        unavailableNode.command = {
          command: COMMAND.RETRY_PROJECT_BOARD,
          title: 'Retry',
          arguments: [normalizedPath],
        };
        return [unavailableNode];
      }

      return [new BrainclawTreeItem(
        'Loading project board...',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        new vscode.ThemeIcon('sync~spin'),
      )];
    }

    const sections = this._buildBoardSections(board, normalizedPath, false);
    if (sections.length === 0) {
      return [new BrainclawTreeItem(
        'No board sections available',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        new vscode.ThemeIcon('info'),
      )];
    }
    return sections;
  }

  private async _loadFullBoardForProject(projectPath: string): Promise<BoardData | null> {
    const normalizedPath = this._normalizePath(projectPath);
    this._loadingProjects.add(normalizedPath);
    try {
      const client = await this._getMcpClient(normalizedPath);
      if (!client) {
        throw new Error(`No brainclaw command found for ${normalizedPath}`);
      }
      const board = await client.callTool('bclaw_context', { kind: 'board' }) as unknown as BoardData;
      this._projectBoards.set(normalizedPath, board);
      this._projectErrors.delete(normalizedPath);
      // Do not clear section cache: each section owns its own TTL + refresh.
      // Wiping on every full-board reload is what produced the mid-refresh
      // "Loading..." flicker users reported (pln#453).
      if (normalizedPath === this._rootProjectPath) {
        this._workspaceBoard = board;
      }
      return board;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._projectBoards.delete(normalizedPath);
      this._projectErrors.set(normalizedPath, message);
      if (normalizedPath === this._rootProjectPath) {
        this._workspaceBoard = null;
      }
      return null;
    } finally {
      this._loadingProjects.delete(normalizedPath);
      this._onDidChangeTreeData.fire();
    }
  }

  private _truncate(input: string, max = 200): string {
    if (input.length <= max) return input;
    return `${input.slice(0, max - 3)}...`;
  }

  private _extractLane(tags?: string[]): string | undefined {
    const laneTag = tags?.find((tag) => tag.startsWith('lane:'));
    return laneTag ? laneTag.slice('lane:'.length) : undefined;
  }

  private _sectionCacheKey(projectPath: string, sectionId: string): string {
    return `${this._normalizePath(projectPath)}::${sectionId}`;
  }

  private _clearSectionCache(projectPath: string): void {
    const normalizedPath = this._normalizePath(projectPath);
    const prefix = `${normalizedPath}::`;
    for (const key of [...this._sectionBoards.keys()]) {
      if (key.startsWith(prefix)) {
        this._sectionBoards.delete(key);
      }
    }
  }

  private _clearJournalDrivenSectionCache(projectPath: string): void {
    const normalizedPath = this._normalizePath(projectPath);
    for (const sectionId of JOURNAL_DRIVEN_SECTIONS) {
      this._sectionBoards.delete(this._sectionCacheKey(normalizedPath, sectionId));
    }
    // Registry sections are journal-served once authoritative; clearing them
    // unconditionally is harmless before that (they just refetch via MCP on
    // the next expand, same as the TTL expiry path).
    for (const sectionId of REGISTRY_JOURNAL_SECTIONS) {
      this._sectionBoards.delete(this._sectionCacheKey(normalizedPath, sectionId));
    }
  }

  private _emptyBoard(): BoardData {
    return {
      active_plans: [],
      active_claims: [],
      active_assignments: [],
      active_runs: [],
      active_actions: [],
      open_handoffs: [],
      runtime_notes: [],
      other_agents: [],
    };
  }

  private _cloneBoard(board?: BoardData | null): BoardData {
    if (!board) {
      return this._emptyBoard();
    }

    return {
      ...this._emptyBoard(),
      ...board,
    };
  }

  private _getSectionBoard(projectPath: string, sectionId: string): BoardData | null | undefined {
    return this._getSectionCacheEntry(projectPath, sectionId)?.board;
  }

  private _getSectionCacheEntry(projectPath: string, sectionId: string): SectionCacheEntry | undefined {
    const key = this._sectionCacheKey(projectPath, sectionId);
    const cached = this._sectionBoards.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this._sectionBoards.delete(key);
      return undefined;
    }
    return cached;
  }

  private _setSectionBoard(projectPath: string, sectionId: string, board: BoardData | null, error?: string): void {
    const key = this._sectionCacheKey(projectPath, sectionId);
    this._sectionBoards.set(key, {
      board,
      error,
      expiresAt: Date.now() + SECTION_CACHE_TTL_MS,
    });
  }

  private _loadingItem(label: string): BrainclawTreeItem {
    return new BrainclawTreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
      undefined,
      new vscode.ThemeIcon('sync~spin'),
    );
  }

  private async _loadSectionBoard(projectPath: string, sectionId: string): Promise<BoardData | null> {
    const normalizedPath = this._normalizePath(projectPath);
    const key = this._sectionCacheKey(normalizedPath, sectionId);
    const existing = this._getSectionCacheEntry(normalizedPath, sectionId);
    if (existing && existing.expiresAt > Date.now()) {
      return existing.board;
    }

    const pending = this._sectionLoadPromises.get(key);
    if (pending) return pending;

    const load = this._runSectionBoardLoad(normalizedPath, sectionId)
      .then((board) => {
        this._setSectionBoard(normalizedPath, sectionId, board);
        return board;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        // NEVER escalate to the full-board load here (pln#558 step 3). That
        // fallback was the contention amplifier: a section load failed
        // because the store was under lock, so we fired the HEAVIEST call
        // against the same store ("contention engendre contention"). Reuse
        // the cached board if we have one and surface the error so the next
        // poll retries the lightweight per-section fetch — the pln#453
        // "never blank the tree on refresh" pattern, applied to errors.
        const stale = this._getSectionCacheEntry(normalizedPath, sectionId);
        if (stale?.board) {
          this._setSectionBoard(normalizedPath, sectionId, stale.board, message);
          return stale.board;
        }
        this._setSectionBoard(normalizedPath, sectionId, null, message);
        return null;
      })
      .finally(() => {
        this._sectionLoadPromises.delete(key);
        this._onDidChangeTreeData.fire();
      });

    this._sectionLoadPromises.set(key, load);
    return load;
  }

  private async _findEntities<T = any>(
    client: McpClient,
    entity: CanonicalEntity,
    filter: Record<string, unknown> = {},
  ): Promise<T[]> {
    // trp#925 — bclaw_find size-bounds each page to ~40k chars and plan lists
    // sort oldest-first, so a single call silently truncates recent items and
    // the Backlog/SPRINTS/LIVE sections miss the newest work. Walk has_more /
    // next_offset until exhausted (cap FIND_MAX_PAGES to bound the loop).
    return paginatedFind<T>(client, entity, filter);
  }

  private async _runSectionBoardLoad(projectPath: string, sectionId: string): Promise<BoardData> {
    // pln#560 slice3 — serve fully journal-driven sections from the in-memory
    // projection (zero MCP) when observerMode is on AND the journal is actually
    // present. The observer is created by _runAgentBoard (board loads before any
    // section expands), so we only READ the cached one here — never create it
    // with a path-keyed cursor that would diverge from the project_id-keyed one.
    // When the journal is off/absent (§9) the projection is empty, so fall
    // through to the MCP fetch rather than render an empty section.
    if (this._observerEnabled() && JOURNAL_DRIVEN_SECTIONS.has(sectionId)) {
      const normalizedPath = this._normalizePath(projectPath);
      const observer = this._observers.get(normalizedPath);
      if (observer && fs.existsSync(path.join(normalizedPath, '.brainclaw', 'events'))) {
        observer.ingest();
        const projected = observer.board();
        const board = this._cloneBoard(this._getBoardForPath(projectPath));
        board.active_plans = projected.active_plans;
        board.known_traps = projected.known_traps;
        board.open_handoffs = projected.open_handoffs;
        return board;
      }
    }

    // pln#560 completion — registry/coordination sections from the projection,
    // gated on registry authority (see REGISTRY_JOURNAL_SECTIONS). Entity
    // content is zero-MCP; the composites (ATTENTION, IN_PROGRESS) enrich with
    // the non-journaled extras through a NULLABLE client — no brainclaw binary
    // still renders the entities, just without hints/loops/evidence.
    if (this._observerEnabled() && REGISTRY_JOURNAL_SECTIONS.has(sectionId)) {
      const normalizedPath = this._normalizePath(projectPath);
      const observer = this._observers.get(normalizedPath);
      if (observer && fs.existsSync(path.join(normalizedPath, '.brainclaw', 'events'))) {
        observer.ingest();
        if (observer.registryAuthoritative()) {
          return this._buildRegistrySectionFromJournal(normalizedPath, sectionId, observer);
        }
      }
    }

    const client = await this._getMcpClient(projectPath);
    if (!client) {
      throw new Error(`No brainclaw command found for ${projectPath}`);
    }

    const board = this._cloneBoard(this._getBoardForPath(projectPath));

    switch (sectionId) {
      case SECTION.ATTENTION: {
        // pln#393 stp_0859ea93: pull server-computed workflow_hints alongside
        // the actionable entities so the tree surfaces next-action advice
        // without re-deriving it extension-side.
        const [actions, assignments, candidates, runs, context] = await Promise.all([
          this._findEntities(client, 'action', { status: 'pending', limit: 100 }),
          this._findEntities(client, 'assignment', { status: 'blocked', limit: 100 }),
          this._findEntities(client, 'candidate', { status: 'pending', auto_generated: false, limit: 100 }),
          this._findEntities(client, 'agent_run', { limit: 100 }),
          client.callTool('bclaw_context', { kind: 'memory', profile: 'quick' }).catch(() => ({} as Record<string, unknown>)),
        ]);
        board.active_actions = actions;
        board.active_assignments = assignments;
        board.pending_candidates = candidates;
        board.active_runs = runs.filter((run: any) =>
          run.status === 'blocked' || run.status === 'waiting_input' || run.status === 'failed');
        const hints = (context as { workflow_hints?: string[] }).workflow_hints;
        board.workflow_hints = Array.isArray(hints) ? hints : [];
        return board;
      }
      case SECTION.IN_PROGRESS: {
        const [claims, assignments, runs, loopsResult] = await Promise.all([
          this._findEntities(client, 'claim', { status: 'active', limit: 100, includeLegacy: true }),
          this._findEntities(client, 'assignment', { limit: 100, includeLegacy: true }),
          this._findEntities(client, 'agent_run', { limit: 100, includeLegacy: true }),
          this._fetchActiveLoops(client),
        ]);
        // Strict live-work filter + recently-terminal window (pln#559) — the
        // semantics live in board-projection.selectInProgress so the MCP and
        // journal section paths cannot drift.
        const selection = selectInProgress(claims, assignments, runs, Date.now(), RECENTLY_TERMINAL_WINDOW_MS);
        board.active_claims = selection.active_claims;
        board.active_assignments = selection.live_assignments;
        board.active_runs = selection.live_runs;
        board.active_loops = loopsResult;
        board.recently_terminal_assignments = selection.recently_terminal_assignments;
        board.dispatch_statuses = await this._enrichDispatchStatuses(client, [
          ...selection.live_assignments,
          ...selection.recently_terminal_assignments,
        ]);
        return board;
      }
      case SECTION.SPRINTS:
      case SECTION.SPRINT: {
        const activeSequences = await this._findEntities(client, 'sequence', { status: 'active', limit: 20 });
        board.active_sequence = activeSequences[0];
        return board;
      }
      case SECTION.BACKLOG: {
        // Independent fetches — plans + traps side-by-side. includeLegacy=true
        // on traps because pre-v1 captures are all tagged provenance.kind='legacy'
        // (see default read filter in src/core/entity-operations.ts); without
        // the override, every trap captured before the provenance rollout
        // disappears from the Backlog. Operators still need to see those.
        const [todoPlans, inProgressPlans, traps] = await Promise.all([
          this._findEntities(client, 'plan', { status: 'todo', limit: 100, includeLegacy: true }),
          this._findEntities(client, 'plan', { status: 'in_progress', limit: 100, includeLegacy: true }),
          this._findEntities(client, 'trap', { status: 'active', limit: 100, includeLegacy: true }),
        ]);
        const plansById = new Map<string, any>();
        for (const plan of [...inProgressPlans, ...todoPlans] as any[]) {
          plansById.set(String(plan.id), plan);
        }
        board.active_plans = sortBacklogPlans([...plansById.values()]);
        board.known_traps = traps;
        return board;
      }
      case SECTION.SYSTEM: {
        // pln#558 step 3 — linked_projects + incoming_signals come from the
        // dedicated lightweight endpoint (bclaw_context kind='cross_project')
        // instead of falling back to kind='board'. That fallback was paying
        // for the whole coordination snapshot (claims, plans, agents,
        // handoffs, reputation, …) just to render two summary lists.
        // runtime_note limit is intentionally large: the filter at render
        // time drops ~99% of them (session-lifecycle noise, agent-runtime
        // tracking). Compaction (pln#436) will trim this at the source.
        const [autoCandidates, runtimeNotes, handoffs, crossProject] = await Promise.all([
          this._findEntities(client, 'candidate', { status: 'pending', auto_generated: true, limit: 100, includeLegacy: true }),
          this._findEntities(client, 'runtime_note', { limit: 200, includeLegacy: true }),
          this._findEntities(client, 'handoff', { limit: 50, includeLegacy: true }),
          client.callTool('bclaw_context', { kind: 'cross_project' })
            .catch(() => ({} as Record<string, unknown>)),
        ]);
        board.pending_candidates = autoCandidates;
        board.runtime_notes = runtimeNotes;
        board.open_handoffs = handoffs;
        board.linked_projects = (crossProject as { linked_projects?: any[] }).linked_projects ?? [];
        board.incoming_signals = (crossProject as { incoming_signals?: any[] }).incoming_signals ?? [];
        return board;
      }
      case SECTION.PLANS: {
        board.active_plans = await this._findEntities(client, 'plan', { limit: 100 });
        return board;
      }
      case SECTION.CLAIMS: {
        board.active_claims = await this._findEntities(client, 'claim', { limit: 100 });
        return board;
      }
      case SECTION.ASSIGNMENTS: {
        board.active_assignments = await this._findEntities(client, 'assignment', { limit: 100 });
        return board;
      }
      case SECTION.RUNS: {
        board.active_runs = await this._findEntities(client, 'agent_run', { limit: 100 });
        return board;
      }
      case SECTION.ACTIONS: {
        board.active_actions = await this._findEntities(client, 'action', { status: 'pending', limit: 100 });
        return board;
      }
      case SECTION.CANDIDATES: {
        board.pending_candidates = await this._findEntities(client, 'candidate', { status: 'pending', limit: 100 });
        return board;
      }
      case SECTION.AGENTS:
      case SECTION.ACTIVITY:
      case SECTION.HANDOFFS:
      case SECTION.TRAPS:
      case SECTION.CROSS_PROJECT:
      default: {
        const fullBoard = await this._loadFullBoardForProject(projectPath);
        if (!fullBoard) {
          return board;
        }
        return fullBoard;
      }
    }
  }

  /**
   * pln#560 completion — registry/coordination section content served from the
   * journal projection. Only called once `registryAuthoritative()` is true
   * (see REGISTRY_JOURNAL_SECTIONS). The projection slots are UNFILTERED
   * post-images; sections whose renderers assume a server-side filter get the
   * equivalent pure filter here (pending candidates/…), the rest re-filter at
   * render time exactly as they do for MCP-fetched arrays.
   *
   * The composites keep their non-journaled enrichments (workflow_hints,
   * loops, dispatch evidence) as BEST-EFFORT MCP reads: `client` may be null
   * (no brainclaw binary resolved) and the section still renders its entities
   * — a strict improvement over the MCP path, which throws without a client.
   */
  private async _buildRegistrySectionFromJournal(
    normalizedPath: string,
    sectionId: string,
    observer: BoardObserver,
  ): Promise<BoardData> {
    const projected = observer.board();
    const board = this._cloneBoard(this._getBoardForPath(normalizedPath));

    switch (sectionId) {
      case SECTION.ATTENTION: {
        board.active_actions = projected.active_actions;
        board.pending_candidates = filterPending(projected.pending_candidates);
        board.active_assignments = projected.active_assignments;
        board.active_runs = projected.active_runs;
        const client = await this._getMcpClient(normalizedPath);
        const context = client
          ? await client.callTool('bclaw_context', { kind: 'memory', profile: 'quick' })
            .catch(() => ({} as Record<string, unknown>))
          : {};
        const hints = (context as { workflow_hints?: string[] }).workflow_hints;
        board.workflow_hints = Array.isArray(hints) ? hints : [];
        return board;
      }
      case SECTION.IN_PROGRESS: {
        const selection = selectInProgress(
          projected.active_claims,
          projected.active_assignments,
          projected.active_runs,
          Date.now(),
          RECENTLY_TERMINAL_WINDOW_MS,
        );
        board.active_claims = selection.active_claims;
        board.active_assignments = selection.live_assignments;
        board.active_runs = selection.live_runs;
        board.recently_terminal_assignments = selection.recently_terminal_assignments;
        const client = await this._getMcpClient(normalizedPath);
        board.active_loops = client ? await this._fetchActiveLoops(client) : [];
        board.dispatch_statuses = await this._enrichDispatchStatuses(client, [
          ...selection.live_assignments,
          ...selection.recently_terminal_assignments,
        ]);
        return board;
      }
      case SECTION.SPRINTS:
      case SECTION.SPRINT: {
        // The MCP path fetches sequences with status 'active'; the projection
        // collapses to active-first-else-first-seen, so gate on the status.
        const seq = projected.active_sequence;
        board.active_sequence = seq && (seq as any).status === 'active' ? seq : undefined;
        return board;
      }
      case SECTION.CLAIMS: {
        board.active_claims = projected.active_claims;
        return board;
      }
      case SECTION.ASSIGNMENTS: {
        board.active_assignments = projected.active_assignments;
        return board;
      }
      case SECTION.RUNS: {
        board.active_runs = projected.active_runs;
        return board;
      }
      case SECTION.ACTIONS: {
        board.active_actions = projected.active_actions;
        return board;
      }
      case SECTION.CANDIDATES: {
        board.pending_candidates = filterPending(projected.pending_candidates);
        return board;
      }
      default:
        return board;
    }
  }

  /**
   * pln#559 — surface active loops in the tree (the 2026-06-10 review loop was
   * invisible because nothing rendered loops). Loops aren't a bclaw_find
   * entity; the canonical surface is bclaw_loop(intent='list'). Best-effort:
   * pre-loop brainclaw versions return an error, treat as empty.
   */
  private async _fetchActiveLoops(client: McpClient): Promise<any[]> {
    return client.callTool('bclaw_loop', { intent: 'list', limit: 50 })
      .then((r) => (Array.isArray((r as any).loops) ? (r as any).loops : []) as any[])
      .then((loops) => loops.filter((l: any) => l.status === 'open' || l.status === 'paused'))
      .catch(() => [] as any[]);
  }

  /**
   * pln#559 step 1 — evidence overrides administrative status: fetch
   * bclaw_dispatch_status for live assignments first, then recently-terminal
   * ones, capped at DISPATCH_STATUS_BUDGET (git execs aren't cheap on
   * Windows). The facade does every entity resolution itself, so one call per
   * assignment is fine. A null client (journal path without a resolved
   * brainclaw binary) yields no evidence — rows fall back to their
   * administrative status.
   */
  private async _enrichDispatchStatuses(
    client: McpClient | null,
    targets: any[],
  ): Promise<Record<string, DispatchStatusLite>> {
    const statuses: Record<string, DispatchStatusLite> = {};
    if (!client) return statuses;
    const enrichTargets = targets.slice(0, DISPATCH_STATUS_BUDGET);
    if (enrichTargets.length === 0) return statuses;
    const results = await Promise.allSettled(
      enrichTargets.map((a: any) =>
        client.callTool('bclaw_dispatch_status', { target_id: a.id, tail_log_lines: 0 })),
    );
    enrichTargets.forEach((a: any, i: number) => {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value && typeof r.value === 'object') {
        statuses[a.id] = r.value as DispatchStatusLite;
      }
    });
    return statuses;
  }

  private _buildBoardSections(board: BoardData, projectPath: string, expandWhenPopulated: boolean): BrainclawTreeItem[] {
    const sections: BrainclawTreeItem[] = [];
    // Stable layout: always render the 5 canonical sections (Attention,
    // Live activity, Sprints, Backlog, System). Prior behaviour conditionally
    // hid a section when its count was 0, which made sections appear/disappear
    // as the summary board vs. full board loaded at different speeds. See
    // dec_465ed157 ("Never blank the tree on refresh") + pln#453. An empty
    // section expands to "No items" via _buildSectionChildren empty-state
    // handling, which is clearer than a missing section header.

    // --- Review queue & next actions ---
    const pendingActions = activeActions(board);
    const reviewCandidates = (board.pending_candidates ?? []).filter((c: any) => !isAutoCandidate(c));
    const blockedAssignments = activeAssignments(board).filter((a: any) => a.status === 'blocked');
    const staleRuns = activeRuns(board).filter((r: any) => r.status === 'blocked' || r.status === 'waiting_input' || r.status === 'failed');
    const hints = (board.workflow_hints ?? []).length;
    const attentionCount = pendingActions.length + reviewCandidates.length + blockedAssignments.length + staleRuns.length + hints;
    sections.push(this._ensureSectionItem(
      SECTION.ATTENTION,
      projectPath,
      `Attention required (${attentionCount})`,
      new vscode.ThemeIcon(attentionCount > 0 ? 'bell-dot' : 'bell'),
      undefined,
      attentionCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    ));

    // --- Live activity ---
    // Strictly actual in-progress work: active claims, running assignments,
    // running agent_runs. Count source priority: section cache (post-expand)
    // → project board → summary _counts. This keeps the header in sync with
    // whatever the user actually sees below.
    const liveSectionBoard = this._getSectionBoard(projectPath, SECTION.IN_PROGRESS);
    const claims = activeClaims(liveSectionBoard ?? board);
    const runningAssignments = activeAssignments(liveSectionBoard ?? board).filter((a: any) => a.status !== 'blocked');
    const activeRunsList = activeRuns(liveSectionBoard ?? board).filter((r: any) => r.status !== 'blocked' && r.status !== 'waiting_input' && r.status !== 'failed');
    // pln#559 — loops count as live work too: they were invisible before.
    const liveLoops = (liveSectionBoard?.active_loops ?? board.active_loops ?? []) as any[];
    const liveArrayCount = claims.length + runningAssignments.length + activeRunsList.length + liveLoops.length;
    const summaryLiveCount = board.summary && board._counts
      ? board._counts.claims + board._counts.assignments + board._counts.runs
      : 0;
    const liveCount = liveSectionBoard ? liveArrayCount : (liveArrayCount > 0 ? liveArrayCount : summaryLiveCount);
    sections.push(this._sectionHeader(`Live activity (${liveCount})`, SECTION.IN_PROGRESS, 'play-circle', liveCount, projectPath, expandWhenPopulated && liveCount > 0));

    // --- Sprints ---
    const sprintTotal = board.active_sequence?.items?.length ?? 0;
    sections.push(this._sectionHeader(`Sprints`, SECTION.SPRINTS, 'rocket', sprintTotal, projectPath, expandWhenPopulated && sprintTotal > 0));

    // --- Backlog ---
    // Same count-source priority as Live activity: section cache → project
    // board → summary counts. So once the section is loaded the header
    // reflects "(plans + traps)" rather than just plan count.
    const backlogSectionBoard = this._getSectionBoard(projectPath, SECTION.BACKLOG);
    const backlogBase = backlogSectionBoard ?? board;
    const backlogPlans = activePlans(backlogBase).filter((p: any) => p.status === 'in_progress' || p.status === 'todo');
    const highTraps = (backlogBase.known_traps ?? [])
      .filter((t: any) => (t.status ?? 'active') === 'active')
      .sort((a: any, b: any) => {
        const rank = (s: string) => (s === 'high' ? 0 : s === 'medium' ? 1 : 2);
        return rank(a.severity ?? 'medium') - rank(b.severity ?? 'medium');
      });
    const summaryPlansCount = board.summary && board._counts ? board._counts.plans : 0;
    const backlogCount = backlogSectionBoard
      ? backlogPlans.length + highTraps.length
      : (backlogPlans.length > 0 || highTraps.length > 0
        ? backlogPlans.length + highTraps.length
        : summaryPlansCount);
    sections.push(this._sectionHeader(`Backlog (${backlogCount})`, SECTION.BACKLOG, 'tasklist', backlogCount, projectPath, expandWhenPopulated && backlogCount > 0));

    // --- System (always collapsed) ---
    // Includes the agent roster so "Live activity" stays strictly scoped
    // to in-flight work (dec_465ed157 section-semantics principle).
    const agentRoster = board.other_agents ?? [];
    const autoCandidates = (board.pending_candidates ?? []).filter((c: any) => isAutoCandidate(c));
    const notes = board.runtime_notes ?? [];
    const handoffs = visibleHandoffs(board);
    const linked = board.linked_projects ?? [];
    const signals = board.incoming_signals ?? [];
    const systemCount = agentRoster.length + autoCandidates.length + notes.length + handoffs.length + linked.length + signals.length;
    sections.push(this._ensureSectionItem(
      SECTION.SYSTEM,
      projectPath,
      `System`,
      new vscode.ThemeIcon('server'),
      systemCount > 0 ? `${systemCount} item(s)` : undefined,
      vscode.TreeItemCollapsibleState.Collapsed,
    ));

    return sections;
  }

  private _sectionHeader(
    label: string,
    sectionId: string,
    icon: string,
    count: number,
    projectPath: string,
    expandWhenPopulated: boolean,
  ): BrainclawTreeItem {
    // pln#457: reuse the cached instance so fire(sectionItem) resolves the
    // same object VS Code already has in its tree. Expanded state is set on
    // first build and preserved by VS Code via the treeId; we don't touch
    // collapsibleState on subsequent rebuilds to avoid force-collapsing a
    // section the user expanded manually.
    return this._ensureSectionItem(
      sectionId,
      projectPath,
      label,
      new vscode.ThemeIcon(icon),
      undefined,
      expandWhenPopulated && count > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
  }

  private _ensureSectionItem(
    sectionId: string,
    projectPath: string,
    label: string,
    icon: vscode.ThemeIcon,
    description: string | undefined,
    initialCollapsibleState: vscode.TreeItemCollapsibleState,
  ): BrainclawTreeItem {
    const key = this._sectionCacheKey(projectPath, sectionId);
    const existing = this._sectionItems.get(key);
    if (existing) {
      // Mutate in place: label/description/iconPath often carry live counts.
      // collapsibleState is left alone so the user's manual expand/collapse
      // survives a refresh.
      existing.label = label;
      existing.description = description;
      existing.iconPath = icon;
      return existing;
    }
    const fresh = new BrainclawTreeItem(
      label,
      initialCollapsibleState,
      description,
      icon,
      undefined,
      undefined,
      undefined,
      projectPath,
      sectionId,
      'section',
      `section:${projectPath}:${sectionId}`,
    );
    this._sectionItems.set(key, fresh);
    return fresh;
  }

  private _buildSectionChildren(sectionId: string, board: BoardData, projectPath: string): BrainclawTreeItem[] {
    switch (sectionId) {
      // Outcome sections
      case SECTION.ATTENTION: return this._buildAttentionChildren(board, projectPath);
      case SECTION.IN_PROGRESS: return this._buildInProgressChildren(board, projectPath);
      case SECTION.SPRINTS: return this._buildSprint(board, projectPath);
      case SECTION.BACKLOG: return this._buildBacklogChildren(board, projectPath);
      case SECTION.SYSTEM: return this._buildSystemChildren(board, projectPath);
      // Entity sections (legacy, kept for compatibility)
      case SECTION.AGENTS: return this._buildAgents(board, projectPath);
      case SECTION.CANDIDATES: return this._buildCandidates(board, projectPath);
      case SECTION.ACTIVITY: return this._buildActivity(board, projectPath);
      case SECTION.PLANS: return this._buildPlans(board, projectPath);
      case SECTION.CLAIMS: return this._buildClaims(board, projectPath);
      case SECTION.ASSIGNMENTS: return this._buildAssignments(board, projectPath);
      case SECTION.RUNS: return this._buildRuns(board, projectPath);
      case SECTION.ACTIONS: return this._buildActions(board, projectPath);
      case SECTION.HANDOFFS: return this._buildHandoffs(board, projectPath);
      case SECTION.SPRINT: return this._buildSprint(board, projectPath);
      case SECTION.TRAPS: return this._buildTraps(board, projectPath);
      case SECTION.CROSS_PROJECT: return this._buildCrossProject(board, projectPath);
      default: return [];
    }
  }

  private _buildAttentionChildren(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const items: BrainclawTreeItem[] = [];

    if (activeActions(board).length > 0) {
      items.push(...this._buildActions(board, projectPath));
    }

    const reviewCandidates = (board.pending_candidates ?? []).filter((c: any) => !isAutoCandidate(c));
    items.push(...this._buildCandidateItems(reviewCandidates, projectPath));

    const blockedAssignments = activeAssignments(board).filter((a: any) => a.status === 'blocked');
    if (blockedAssignments.length > 0) {
      items.push(...this._buildAssignmentItems(blockedAssignments, projectPath));
    }

    const staleRuns = activeRuns(board).filter((r: any) => r.status === 'blocked' || r.status === 'waiting_input' || r.status === 'failed');
    if (staleRuns.length > 0) {
      items.push(...this._buildRunItems(staleRuns, projectPath));
    }

    // pln#393 stp_0859ea93: server-computed next-action hints. These are
    // advisory strings from bclaw_context; rendered as read-only leaves so
    // the extension never invents them.
    items.push(...this._buildWorkflowHintItems(board.workflow_hints ?? [], projectPath));

    if (items.length === 0) return [this._emptyLeaf('Nothing needs your attention')];
    return items;
  }

  private _buildWorkflowHintItems(hints: string[], projectPath: string): BrainclawTreeItem[] {
    return hints.map((hint, index) => new BrainclawTreeItem(
      hint,
      vscode.TreeItemCollapsibleState.None,
      'next action',
      new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('editorInfo.foreground')),
      hint,
      'workflow-hint',
      undefined,
      projectPath,
      undefined,
      'leaf',
      `workflow-hint:${projectPath}:${index}`,
    ));
  }

  private _buildInProgressChildren(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    // Work only — no roster. Claims + running assignments + running agent_runs.
    const items: BrainclawTreeItem[] = [];
    const dispatchStatuses = board.dispatch_statuses;

    items.push(...this._buildClaims(board, projectPath));

    const runningAssignments = activeAssignments(board).filter((a: any) => a.status !== 'blocked');
    if (runningAssignments.length > 0) {
      items.push(...this._buildAssignmentItems(runningAssignments, projectPath, { dispatchStatuses }));
    }

    const activeRunsList = activeRuns(board).filter((r: any) => r.status !== 'blocked' && r.status !== 'waiting_input' && r.status !== 'failed');
    if (activeRunsList.length > 0) {
      items.push(...this._buildRunItems(activeRunsList, projectPath));
    }

    // pln#559 step 5 — loops as first-class entries in Live activity. Previously
    // invisible: the 2026-06-10 review loop ran without ANY surface, leaving
    // the operator to discover it via inbox messages.
    const loops = (board.active_loops ?? []) as any[];
    if (loops.length > 0) {
      items.push(...this._buildLoopItems(loops, projectPath));
    }

    // pln#559 step 2 — terminal-within-window rows under a divider. The
    // 2026-06-10 false-expirations would have been invisible without this.
    const terminal = (board.recently_terminal_assignments ?? []) as any[];
    if (terminal.length > 0) {
      items.push(this._sectionDivider(
        `Recently terminal (${terminal.length})`,
        `recently-terminal:${projectPath}`,
      ));
      items.push(...this._buildAssignmentItems(terminal, projectPath, { dispatchStatuses, terminal: true }));
    }

    if (items.length === 0) return [this._emptyLeaf('No active claims, assignments, or runs')];
    return items;
  }

  /**
   * pln#559 step 2 — non-expandable header used as a visual separator inside
   * a section (between live and terminal rows). Distinct icon so it doesn't
   * read like a real entity.
   */
  private _sectionDivider(label: string, treeId: string): BrainclawTreeItem {
    return new BrainclawTreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
      undefined,
      new vscode.ThemeIcon('list-flat'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'leaf',
      treeId,
    );
  }

  /**
   * pln#559 step 5 — render active loops (one row per loop). Carries the
   * iteration / current phase so the operator sees the work without leaving
   * the tree. Tooltip lists the slots and their statuses.
   */
  private _buildLoopItems(loops: any[], projectPath: string): BrainclawTreeItem[] {
    return loops.map((loop: any) => {
      const phaseName = loop.current_phase ?? '?';
      const iter = typeof loop.iteration_count === 'number' ? loop.iteration_count : 0;
      const slots: any[] = Array.isArray(loop.slots) ? loop.slots : [];
      const slotSummary = slots
        .map((s) => `${s.role ?? s.id ?? '?'}=${s.status ?? '?'}`)
        .join(', ');
      const desc = `${loop.kind ?? 'loop'} · phase=${phaseName} · iter=${iter}`;
      const tooltipLines: string[] = [
        `Loop: ${loop.id}`,
        `Title: ${loop.title ?? ''}`,
        `Kind: ${loop.kind ?? '?'}`,
        `Status: ${loop.status ?? '?'}`,
        `Phase: ${phaseName} (iteration ${iter})`,
      ];
      if (slotSummary) tooltipLines.push(`Slots: ${slotSummary}`);
      if (loop.goal) tooltipLines.push('', `Goal: ${loop.goal}`);
      const icon = loop.status === 'paused' ? 'debug-pause' : 'sync';
      return new BrainclawTreeItem(
        loop.title ?? loop.id,
        vscode.TreeItemCollapsibleState.None,
        desc,
        new vscode.ThemeIcon(icon),
        tooltipLines.join('\n'),
        'loop',
        loop.id,
        projectPath,
        undefined,
        'leaf',
        `loop:${projectPath}:${loop.id}`,
      );
    });
  }

  private _buildBacklogChildren(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const items: BrainclawTreeItem[] = [];

    const backlogPlans = sortBacklogPlans(activePlans(board).filter((p: any) => p.status === 'in_progress' || p.status === 'todo'));
    items.push(...this._buildPlanItems(backlogPlans, projectPath));

    const highTraps = (board.known_traps ?? [])
      .filter((t: any) => (t.status ?? 'active') === 'active')
      .sort((a: any, b: any) => {
        const rank = (s: string) => (s === 'high' ? 0 : s === 'medium' ? 1 : 2);
        return rank(a.severity ?? 'medium') - rank(b.severity ?? 'medium');
      });
    items.push(...this._buildTrapItems(highTraps, projectPath));

    if (items.length === 0) return [this._emptyLeaf('No backlog items')];
    return items;
  }

  private _emptyLeaf(message: string): BrainclawTreeItem {
    return new BrainclawTreeItem(
      message,
      vscode.TreeItemCollapsibleState.None,
      undefined,
      new vscode.ThemeIcon('info'),
    );
  }

  private _buildSystemChildren(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    // System = reference data. Registered agents (roster), cross-project
    // links, incoming signals, runtime notes, handoffs, auto-generated
    // candidates. Human browses this occasionally; it's not the daily cockpit.
    const items: BrainclawTreeItem[] = [];

    if ((board.other_agents ?? []).length > 0) {
      items.push(...this._buildAgents(board, projectPath));
    }

    if ((board.runtime_notes ?? []).length > 0) {
      items.push(...this._buildActivity(board, projectPath));
    }

    const autoCandidates = (board.pending_candidates ?? []).filter((c: any) => isAutoCandidate(c));
    items.push(...this._buildCandidateItems(autoCandidates, projectPath));

    if (visibleHandoffs(board).length > 0) {
      items.push(...this._buildHandoffs(board, projectPath));
    }

    const linked = board.linked_projects ?? [];
    const signals = board.incoming_signals ?? [];
    if (linked.length > 0 || signals.length > 0) {
      items.push(...this._buildCrossProject(board, projectPath));
    }

    if (items.length === 0) return [this._emptyLeaf('No system items')];
    return items;
  }

  private _buildAgents(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const agents = board.other_agents ?? [];
    if (agents.length === 0) {
      return [new BrainclawTreeItem('No agents registered', vscode.TreeItemCollapsibleState.None, undefined, new vscode.ThemeIcon('info'))];
    }

    const sorted = [...agents].sort((left: any, right: any) => {
      const order = { active: 0, idle: 1, stale: 2 };
      return (order[agentFreshness(left)] ?? 3) - (order[agentFreshness(right)] ?? 3);
    });

    return sorted.map((agent: any) => {
      const freshness = agentFreshness(agent);
      const ago = agent.last_active ? timeAgo(agent.last_active) : 'never';
      const session = agent.has_open_session ? ' · session open' : '';
      const claims = agent.claim_count > 0 ? ` · ${agent.claim_count} claim(s)` : '';
      const desc = freshness === 'stale' ? `${agent.trust_level} · ${ago}` : `${agent.trust_level}${claims}${session} · ${ago}`;
      const scopeList = (agent.scopes ?? []).join(', ');
      const summary = `Agent: ${agent.name}\nTrust: ${agent.trust_level}\nClaims: ${agent.claim_count}\nScopes: ${scopeList || 'none'}\nLast active: ${ago}\nSession: ${agent.has_open_session ? 'open' : 'closed'}`;
      const agentKey = agent.id ?? agent.name;

      const item = new BrainclawTreeItem(
        agent.name,
        vscode.TreeItemCollapsibleState.None,
        desc,
        freshnessIcon(freshness),
        summary,
        'agent',
        agentKey,
        projectPath,
        undefined,
        'leaf',
        `agent:${projectPath}:${agentKey}`,
      );
      attachEntityPreview(item, 'agent', agentKey, projectPath, summary);
      return item;
    });
  }

  private _buildCandidateItems(candidates: any[], projectPath: string): BrainclawTreeItem[] {
    return candidates.map((candidate: any) => {
      const age = candidate.created_at ? timeAgo(candidate.created_at) : '';
      const overdue = candidate.overdue ? ' OVERDUE' : '';
      return new BrainclawTreeItem(
        candidate.text?.slice(0, 80) ?? candidate.id,
        vscode.TreeItemCollapsibleState.None,
        `${candidate.type} by ${candidate.author ?? '?'} · ${age}${overdue}`,
        new vscode.ThemeIcon(candidate.overdue ? 'bell-dot' : 'comment-discussion'),
        `[${candidate.id}] ${candidate.type}\n${candidate.text}\nBy: ${candidate.author ?? 'unknown'}\nAge: ${age}${overdue}`,
        'candidate',
        candidate.id,
        projectPath,
        undefined,
        'leaf',
        `candidate:${projectPath}:${candidate.id}`,
      );
    });
  }

  private _buildCandidates(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    return this._buildCandidateItems(board.pending_candidates ?? [], projectPath);
  }

  private _buildActivity(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    // Filter out session-lifecycle noise: "Session started / ended" notes
    // (tagged `session`) accumulate at 1000s-per-project and bury real
    // operator signal. Same for per-run/per-assignment tracking notes
    // (`agent-runtime`), which are more usefully surfaced as runs /
    // assignments in Live activity, not duplicated here. Keep the last
    // 10 human-facing notes only.
    const NOISE_TAGS = new Set(['session', 'agent-runtime']);
    const isSignal = (note: any): boolean => {
      const tags = Array.isArray(note.tags) ? note.tags : [];
      if (tags.length === 0) return true;
      return !tags.some((tag: string) => NOISE_TAGS.has(tag));
    };
    const notes = (board.runtime_notes ?? [])
      .filter(isSignal)
      .slice(-10)
      .reverse();
    return notes.map((note: any) => {
      const ago = note.created_at ? timeAgo(note.created_at) : '';
      return new BrainclawTreeItem(
        note.text?.slice(0, 80) ?? 'note',
        vscode.TreeItemCollapsibleState.None,
        `${note.agent} · ${ago}`,
        new vscode.ThemeIcon('comment'),
        `[${note.id}] ${note.agent}\n${note.text}\n${ago}`,
        undefined,
        undefined,
        projectPath,
        undefined,
        'leaf',
        `note:${projectPath}:${note.id}`,
      );
    });
  }

  private _buildPlanItems(plans: any[], projectPath: string): BrainclawTreeItem[] {
    return plans.map((plan: any) => {
      const assignee = plan.assignee ? ` @${plan.assignee}` : '';
      const stepsInfo = plan.steps?.length ? ` [${plan.steps.filter((step: any) => step.status === 'done').length}/${plan.steps.length}]` : '';
      const icon = plan.status === 'in_progress' ? 'play-circle' : plan.status === 'blocked' ? 'error' : 'circle-outline';
      const summary = `[${plan.id}] ${plan.text}\nStatus: ${plan.status}\nPriority: ${plan.priority ?? 'medium'}${assignee}${stepsInfo}`;
      const age = plan.created_at ? formatRelativeAge(plan.created_at) : '—';
      const prio = priorityLetter(plan.priority);
      const title = plan.text ?? plan.id;
      const item = new BrainclawTreeItem(
        `${age} · ${prio} · ${title}`,
        vscode.TreeItemCollapsibleState.None,
        stepsInfo.trim() || undefined,
        new vscode.ThemeIcon(icon),
        summary,
        'plan',
        plan.id,
        projectPath,
        undefined,
        'leaf',
        `plan:${projectPath}:${plan.id}`,
      );
      attachEntityPreview(item, 'plan', plan.id, projectPath, summary);
      return item;
    });
  }

  private _buildPlans(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const plans = activePlans(board);
    if (plans.length === 0) {
      return [new BrainclawTreeItem('No active plans', vscode.TreeItemCollapsibleState.None)];
    }
    return this._buildPlanItems(plans, projectPath);
  }

  private _buildClaims(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const claims = activeClaims(board);
    return claims.map((claim: any) => {
      const ago = claim.created_at ? timeAgo(claim.created_at) : '';
      const summary = `Claimed by: ${claim.agent}\nScope: ${claim.scope}\nDescription: ${claim.description ?? ''}\nSince: ${ago}`;
      // pln#559 finitions — D8: claims older than STALE_MS.claim (4h) dim
      // out. A 16h-old claim is almost always a dangling one from a
      // crashed worker — surfacing the staleness invites release.
      const claimReference = claim.updated_at ?? claim.created_at;
      const stale = isStale(claimReference, STALE_MS.claim);
      const description = stale ? `by ${claim.agent} · ${ago} · stale` : `by ${claim.agent} · ${ago}`;
      const item = new BrainclawTreeItem(
        stale ? `· ${claim.scope}` : claim.scope,
        vscode.TreeItemCollapsibleState.None,
        description,
        new vscode.ThemeIcon('shield', stale ? new vscode.ThemeColor('disabledForeground') : undefined),
        summary,
        'claim',
        claim.id,
        projectPath,
        undefined,
        'leaf',
        `claim:${projectPath}:${claim.id}`,
      );
      attachEntityPreview(item, 'claim', claim.id, projectPath, summary);
      return item;
    });
  }

  /**
   * pln#559 step 1 — build the "evidence digest" line that replaces the
   * administrative `status · agent · last_heartbeat` triplet that lied 4×
   * on 2026-06-10. The verdict comes from dispatch_status.diagnosis.health,
   * the digest from runtime.commits_ahead/dirty_tracked + last_fs_activity.
   * Returns undefined when no status is available (caller falls back).
   */
  private _formatDispatchDigest(status: DispatchStatusLite | undefined): string | undefined {
    if (!status?.diagnosis) return undefined;
    const health = status.diagnosis.health ?? 'unknown';
    const parts: string[] = [health];
    const rt = status.runtime ?? {};
    if (typeof rt.commits_ahead === 'number') {
      const dirty = rt.dirty_tracked ?? 0;
      const clean = rt.commits_ahead > 0 && dirty === 0;
      parts.push(`${rt.commits_ahead}↑${clean ? ' clean' : dirty > 0 ? ` · ${dirty} dirty` : ''}`);
    }
    if (typeof rt.last_fs_activity_ms === 'number') {
      const s = Math.max(0, Math.round(rt.last_fs_activity_ms / 1000));
      parts.push(s < 60 ? `fs ${s}s` : s < 3600 ? `fs ${Math.round(s / 60)}m` : `fs ${Math.round(s / 3600)}h`);
    }
    if (rt.lane_result) {
      parts.push(`lane-result:${rt.lane_result.status}`);
    }
    if (rt.pid_alive === false) parts.push('pid dead');
    return parts.join(' · ');
  }

  private _buildAssignmentItems(
    assignments: any[],
    projectPath: string,
    options?: { dispatchStatuses?: Record<string, DispatchStatusLite>; terminal?: boolean },
  ): BrainclawTreeItem[] {
    const statuses = options?.dispatchStatuses;
    const terminalRow = options?.terminal === true;
    return assignments.map((assignment: any) => {
      const heartbeatAgo = assignment.last_heartbeat_at ? timeAgo(assignment.last_heartbeat_at) : 'no heartbeat yet';
      const status = statuses?.[assignment.id];
      const digest = this._formatDispatchDigest(status);
      const health = status?.diagnosis?.health;

      // Icon priority: evidence-based health > administrative status.
      // A terminal-but-contradicted assignment (status=expired but commits ahead)
      // surfaces with a warning so the operator catches the registry lie at
      // a glance — the 2026-06-10 trap.
      const evidenceIcon = health === 'silent_death'
        ? 'error'
        : health === 'stalled'
          ? 'warning'
          : health === 'healthy'
            ? 'play-circle'
            : health === 'terminal'
              ? ((status?.runtime?.commits_ahead ?? 0) > 0 ? 'cloud-upload' : 'check')
              : undefined;
      const adminIcon = terminalRow
        ? (assignment.status === 'completed' ? 'check'
          : assignment.status === 'failed' ? 'error'
          : assignment.status === 'expired' ? 'circle-slash'
          : assignment.status === 'timed_out' ? 'clock'
          : 'circle-outline')
        : (assignment.status === 'started' ? 'play-circle'
          : assignment.status === 'accepted' ? 'check'
          : assignment.status === 'offered' ? 'mail'
          : assignment.status === 'blocked' ? 'warning'
          : 'circle-outline');
      const icon = evidenceIcon ?? adminIcon;

      // pln#559 finitions — stale heartbeat dims the row. A stale heartbeat
      // alone never marked anything; combined with evidence (pid dead /
      // health=silent_death) it now reads at a glance.
      const heartbeatStale = isStale(assignment.last_heartbeat_at, STALE_MS.assignment);
      const dim = heartbeatStale && (status?.runtime?.pid_alive === false || health === 'silent_death');

      const label = assignment.description?.slice(0, 80) || assignment.scope || assignment.id;

      // Description: evidence digest if available, else legacy admin triplet.
      let description: string;
      if (digest) {
        description = `${digest} · ${assignment.agent}`;
        // For a terminal row also surface provenance (sweep vs self-report)
        // so the operator sees WHO transitioned the assignment.
        if (terminalRow) {
          const provenance = this._terminalProvenance(assignment);
          description = `${assignment.status} ${provenance ? `(${provenance}) ` : ''}· ${description}`;
        }
      } else {
        description = `${assignment.status} · ${assignment.agent} · ${heartbeatAgo}`;
      }

      // Tooltip: verbatim diagnosis.summary + recommended_next_action so the
      // operator sees the same verdict bclaw_dispatch_status would print.
      const plan = assignment.plan_id ? `\nPlan: ${assignment.plan_id}` : '';
      const tooltipLines: string[] = [
        `Assignment: ${assignment.id}`,
        `Agent: ${assignment.agent}`,
        `Status: ${assignment.status}${assignment.status_reason ? ` (${assignment.status_reason})` : ''}`,
        `Scope: ${assignment.scope}`,
      ];
      if (plan) tooltipLines.push(plan.trim());
      tooltipLines.push(`Last heartbeat: ${heartbeatAgo}`);
      if (status?.diagnosis) {
        tooltipLines.push('', `Verdict: ${status.diagnosis.health ?? 'unknown'}`);
        if (status.diagnosis.summary) tooltipLines.push(status.diagnosis.summary);
        if (status.diagnosis.recommended_next_action) {
          tooltipLines.push('', `Next: ${status.diagnosis.recommended_next_action}`);
        }
      }
      const finalDescription = dim ? `${description} · stale` : description;
      const item = new BrainclawTreeItem(
        dim ? `· ${label}` : label,
        vscode.TreeItemCollapsibleState.None,
        finalDescription,
        new vscode.ThemeIcon(icon, dim ? new vscode.ThemeColor('disabledForeground') : undefined),
        tooltipLines.join('\n'),
        // contextValue toggles whether triage shortcuts (Open worktree,
        // Show captured logs) appear in the inline / context menu.
        terminalRow ? 'assignment-terminal' : 'assignment',
        assignment.id,
        projectPath,
        undefined,
        'leaf',
        `assignment:${projectPath}:${assignment.id}`,
      );
      // Attach worktree_path / log paths via item properties so the triage
      // commands (brainclaw.openWorktree / brainclaw.showLogs) resolve them
      // without another MCP round-trip.
      const logFiles = status?.runtime?.log_files;
      const logPaths = [logFiles?.stdout?.path, logFiles?.stderr?.path]
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      (item as any).worktreePath = assignment.worktree_path;
      (item as any).logPaths = logPaths;
      return item;
    });
  }

  /**
   * pln#559 step 2 — best-guess provenance of a terminal transition. The
   * assignment carries timestamps (expired_at, failed_at, …) and a
   * status_reason set by whichever subsystem flipped it. Returns a short
   * tag (e.g. "ttl-sweep", "self-report", "reconciler") for inline display.
   */
  private _terminalProvenance(assignment: any): string | undefined {
    const reason = String(assignment.status_reason ?? '').toLowerCase();
    if (!reason) return undefined;
    if (reason.includes('sweep') || reason.includes('ttl')) return 'sweep';
    if (reason.includes('reconcil')) return 'reconciler';
    if (reason.includes('self') || reason.includes('report')) return 'self-report';
    if (reason.includes('harvest')) return 'harvest';
    if (reason.includes('rerout')) return 'rerouted';
    // Default: surface the raw reason truncated so it remains informative.
    return reason.slice(0, 24);
  }

  private _buildAssignments(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const assignments = activeAssignments(board);
    if (assignments.length === 0) {
      return [new BrainclawTreeItem('No active assignments', vscode.TreeItemCollapsibleState.None)];
    }
    return this._buildAssignmentItems(assignments, projectPath);
  }

  private _buildRunItems(runs: any[], projectPath: string): BrainclawTreeItem[] {
    return runs.map((run: any) => {
      const ago = run.last_event_at ? timeAgo(run.last_event_at) : 'no events yet';
      const icon = run.status === 'running'
        ? 'play-circle'
        : run.status === 'launching'
          ? 'loading~spin'
          : run.status === 'waiting_input'
            ? 'clock'
            : run.status === 'blocked'
              ? 'warning'
              : 'circle-outline';
      const label = `${run.description?.slice(0, 70) || run.scope || run.id} [#${run.attempt_index}]`;
      // pln#559 finitions — D8: dim+warn runs whose last_event_at is past the
      // assignment-staleness threshold. A "running" row whose events stopped
      // 45min ago is visually distinct from a fresh one.
      const stale = isStale(run.last_event_at, STALE_MS.assignment) && run.status === 'running';
      const description = stale ? `${run.status} · ${run.transport} · ${ago} · stale` : `${run.status} · ${run.transport} · ${ago}`;
      return new BrainclawTreeItem(
        stale ? `· ${label}` : label,
        vscode.TreeItemCollapsibleState.None,
        description,
        new vscode.ThemeIcon(icon, stale ? new vscode.ThemeColor('disabledForeground') : undefined),
        `Run: ${run.id}\nAssignment: ${run.assignment_id}\nAgent: ${run.agent}\nStatus: ${run.status}\nTransport: ${run.transport}\nAttempt: ${run.attempt_index}\nScope: ${run.scope}\nLast event: ${ago}`,
        'run',
        run.id,
        projectPath,
        undefined,
        'leaf',
        `run:${projectPath}:${run.id}`,
      );
    });
  }

  private _buildRuns(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const runs = activeRuns(board);
    if (runs.length === 0) {
      return [new BrainclawTreeItem('No active runs', vscode.TreeItemCollapsibleState.None)];
    }
    return this._buildRunItems(runs, projectPath);
  }

  private _buildActions(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const actions = activeActions(board);
    if (actions.length === 0) {
      return [new BrainclawTreeItem('No pending actions', vscode.TreeItemCollapsibleState.None)];
    }

    return actions.map((action: any) => {
      const ago = action.updated_at ? timeAgo(action.updated_at) : timeAgo(action.created_at);
      const icon = action.kind === 'approval'
        ? 'shield'
        : action.kind === 'plan_approval'
          ? 'checklist'
          : action.kind === 'user_input'
            ? 'comment-discussion'
            : 'question';
      const label = action.title?.slice(0, 80) || action.prompt?.slice(0, 80) || action.id;
      const scope = action.scope ? `\nScope: ${action.scope}` : '';
      const options = Array.isArray(action.options) && action.options.length > 0
        ? `\nOptions: ${action.options.join(', ')}`
        : '';

      return new BrainclawTreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
        `${action.kind} · ${action.agent} · ${ago}`,
        new vscode.ThemeIcon(icon),
        `Action: ${action.id}\nKind: ${action.kind}\nAgent: ${action.agent}\nStatus: ${action.status}\nPrompt: ${action.prompt}${scope}${options}`,
        'action',
        action.id,
        projectPath,
        undefined,
        'leaf',
        `action:${projectPath}:${action.id}`,
      );
    });
  }

  private _buildHandoffs(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    return visibleHandoffs(board).map((handoff: any) => {
      const summary = `From: ${handoff.from}\nTo: ${handoff.to}\n${handoff.text ?? ''}`;
      const item = new BrainclawTreeItem(
        handoff.text?.slice(0, 80) ?? handoff.id,
        vscode.TreeItemCollapsibleState.None,
        `${handoff.from ?? '?'} → ${handoff.to ?? '?'}`,
        new vscode.ThemeIcon('arrow-swap'),
        summary,
        'handoff',
        handoff.id,
        projectPath,
        undefined,
        'leaf',
        `handoff:${projectPath}:${handoff.id}`,
      );
      attachEntityPreview(item, 'handoff', handoff.id, projectPath, summary);
      return item;
    });
  }

  private _buildSprint(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const sequence = board.active_sequence;
    if (!sequence?.items) return [];

    const items = sequence.items as any[];
    const doneCount = items.filter((item: any) => item.plan_status === 'done').length;
    const result: BrainclawTreeItem[] = [
      new BrainclawTreeItem(
        this._renderProgressBar(doneCount, items.length),
        vscode.TreeItemCollapsibleState.None,
        `${doneCount}/${items.length} done`,
        new vscode.ThemeIcon('graph'),
        undefined,
        undefined,
        undefined,
        projectPath,
        undefined,
        'leaf',
        `sprint-progress:${projectPath}`,
      ),
    ];

    for (const item of items) {
      const status = item.plan_status ?? 'unknown';
      const icon = status === 'done' ? 'pass' : status === 'in_progress' ? 'play-circle' : 'circle-outline';
      const lane = item.lane ? `[${item.lane}] ` : '';
      const text = item.plan_text ?? item.planId;
      result.push(new BrainclawTreeItem(
        `#${item.rank} ${lane}${text}`,
        vscode.TreeItemCollapsibleState.None,
        status,
        new vscode.ThemeIcon(icon),
        undefined,
        undefined,
        undefined,
        projectPath,
        undefined,
        'leaf',
        `sprint-item:${projectPath}:${item.planId ?? item.rank}`,
      ));
    }

    return result;
  }

  private _renderProgressBar(done: number, total: number): string {
    if (total === 0) return '[ empty ]';
    const filled = Math.round((done / total) * 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${Math.round((done / total) * 100)}%`;
  }

  private _buildTrapItems(traps: any[], projectPath: string): BrainclawTreeItem[] {
    return traps.map((trap: any) => {
      const icon = trap.severity === 'high' ? 'error' : trap.severity === 'medium' ? 'warning' : 'info';
      const summary = `[${trap.severity}] ${trap.text}`;
      const age = trap.created_at ? formatRelativeAge(trap.created_at) : '—';
      const sev = priorityLetter(trap.severity);
      const text = trap.text ?? trap.id;
      const item = new BrainclawTreeItem(
        `${age} · ${sev} · ${text}`,
        vscode.TreeItemCollapsibleState.None,
        undefined,
        new vscode.ThemeIcon(icon),
        summary,
        'trap',
        trap.id,
        projectPath,
        undefined,
        'leaf',
        `trap:${projectPath}:${trap.id}`,
      );
      attachEntityPreview(item, 'trap', trap.id, projectPath, summary);
      return item;
    });
  }

  private _buildTraps(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    return this._buildTrapItems(board.known_traps ?? [], projectPath);
  }

  private _buildCrossProject(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const items: BrainclawTreeItem[] = [];

    const linked = board.linked_projects ?? [];
    for (const linkedProject of linked) {
      const status = linkedProject.available ? 'available' : 'unavailable';
      const agents = linkedProject.agents?.length > 0 ? linkedProject.agents.join(', ') : 'no agents';
      items.push(new BrainclawTreeItem(
        linkedProject.name,
        vscode.TreeItemCollapsibleState.None,
        `${linkedProject.role} · ${linkedProject.active_plans} plans · ${linkedProject.active_claims} claims · ${agents}`,
        new vscode.ThemeIcon(linkedProject.available ? 'remote' : 'remote-explorer'),
        `Project: ${linkedProject.name}\nRole: ${linkedProject.role}\nStatus: ${status}\nPlans: ${linkedProject.active_plans}\nClaims: ${linkedProject.active_claims}\nAgents: ${agents}`,
        undefined,
        undefined,
        projectPath,
        undefined,
        'leaf',
        `linked-project:${projectPath}:${linkedProject.name}`,
      ));
    }

    const signals = board.incoming_signals ?? [];
    for (const signal of signals) {
      const ago = signal.created_at ? timeAgo(signal.created_at) : '';
      items.push(new BrainclawTreeItem(
        signal.preview?.slice(0, 80) ?? signal.id,
        vscode.TreeItemCollapsibleState.None,
        `${signal.entity_type} from ${signal.from_project}/${signal.from_agent} · ${ago}`,
        new vscode.ThemeIcon('mail'),
        `Signal: ${signal.entity_type}\nFrom: ${signal.from_project} / ${signal.from_agent}\n${signal.preview}`,
        undefined,
        undefined,
        projectPath,
        undefined,
        'leaf',
        `signal:${projectPath}:${signal.id}`,
      ));
    }

    if (items.length === 0) {
      items.push(new BrainclawTreeItem('No linked projects', vscode.TreeItemCollapsibleState.None));
    }

    return items;
  }
}

/**
 * Compatibility shim retained for callers that construct their own
 * `McpClient`s outside `BrainclawBoardProvider`. New code should call
 * `resolveBrainclawSpawnPlan` directly (see `./brainclaw-resolver`) — the
 * structured plan is what fixes trp#927 (probe/spawn share the same
 * mechanic, `node <cli.js>` under `shell:false`, never a `.cmd` shim).
 *
 * Returns the plan itself (or undefined on failure). The classified error
 * message is discarded here; use `resolveBrainclawSpawnPlan` if you need it.
 */
export async function resolveBrainclawPlan(cwd: string): Promise<BrainclawSpawnPlan | undefined> {
  const result = await resolveBrainclawSpawnPlan(cwd);
  return result.ok ? result.plan : undefined;
}
