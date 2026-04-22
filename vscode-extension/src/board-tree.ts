import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { McpClient } from './mcp-client';
import {
  STALE_MS,
  agentFreshness,
  formatRelativeAge,
  isAutoCandidate,
  isStale,
  timeAgo,
  type Freshness,
} from './tree-helpers';
import type { OpenEntityArgs, SupportedEntity } from './content-provider';

export interface BoardProject {
  path: string;
  name: string;
  relativePath: string;
  isWorkspaceRoot: boolean;
}

type TreeNodeType = 'leaf' | 'project' | 'section';

export class BrainclawTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly iconPath?: vscode.ThemeIcon | string | vscode.Uri,
    tooltip?: string | vscode.MarkdownString,
    public readonly contextValue?: string,
    public readonly itemId?: string,
    public readonly projectPath?: string,
    public readonly sectionId?: string,
    public readonly nodeType: TreeNodeType = 'leaf',
    treeId?: string,
  ) {
    super(label, collapsibleState);
    if (description) this.description = description;
    if (iconPath) this.iconPath = iconPath;
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
}

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

const SECTION_CACHE_TTL_MS = 30_000;

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
  private readonly _resolvedCmds = new Map<string, string | null>();
  private readonly _resolvingCmds = new Map<string, Promise<string | undefined>>();
  private readonly _disposables: vscode.Disposable[] = [];

  private _workspaceBoard: BoardData | null = null;
  private _refreshTimer?: ReturnType<typeof setTimeout>;
  private _fileDecoRefresh?: () => void;
  private _statusUpdate?: (summary: BrainclawStatusSummary) => void;

  constructor(
    workspaceRoot: string,
    projects: BoardProject[],
    fileDecoRefresh?: () => void,
    statusUpdate?: (summary: BrainclawStatusSummary) => void,
  ) {
    this._workspaceRoot = this._normalizePath(workspaceRoot);
    this._projects = this._dedupeProjects(projects);
    this._fileDecoRefresh = fileDecoRefresh;
    this._statusUpdate = statusUpdate;
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
      this._startWatches();
    }, 0);
  }

  public async refresh(): Promise<void> {
    await this._refreshBoards();
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

  public async quickCapture(text: string): Promise<void> {
    const targetCwd = this._normalizePath(this._rootProjectPath ?? this._workspaceRoot);
    const client = await this._getMcpClient(targetCwd);
    if (!client) {
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
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
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
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
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
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
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
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
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
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
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
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
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
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
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
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
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
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
    this._onDidChangeTreeData.fire();
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
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
  }

  private async _getMcpClient(projectPath: string): Promise<McpClient | null> {
    const normalizedPath = this._normalizePath(projectPath);
    const existing = this._mcpClients.get(normalizedPath);
    if (existing) return existing;

    const bclaw = await this._resolveCmd(normalizedPath);
    if (!bclaw) return null;

    const client = new McpClient(normalizedPath, bclaw);
    this._mcpClients.set(normalizedPath, client);
    return client;
  }

  private async _resolveCmd(cwd: string): Promise<string | undefined> {
    const normalizedPath = this._normalizePath(cwd);
    if (this._resolvedCmds.has(normalizedPath)) {
      const resolved = this._resolvedCmds.get(normalizedPath);
      return resolved ?? undefined;
    }

    const pending = this._resolvingCmds.get(normalizedPath);
    if (pending) return pending;

    const resolvePromise = resolveBrainclawCmd(normalizedPath)
      .then((resolved) => {
        this._resolvedCmds.set(normalizedPath, resolved ?? null);
        return resolved;
      })
      .finally(() => {
        this._resolvingCmds.delete(normalizedPath);
      });

    this._resolvingCmds.set(normalizedPath, resolvePromise);
    return resolvePromise;
  }

  private _startWatches(): void {
    for (const project of this._projects) {
      this._startWatch(project.path);
    }
  }

  private _startWatch(projectPath: string): void {
    const normalizedPath = this._normalizePath(projectPath);
    if (this._watchers.has(normalizedPath)) return;

    const brainclawDir = path.join(normalizedPath, '.brainclaw');
    if (!fs.existsSync(brainclawDir)) return;

    try {
      const watcher = fs.watch(brainclawDir, (_eventType, filename) => {
        if (filename && (filename === 'events.jsonl' || String(filename).endsWith('events.jsonl'))) {
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
      _counts: {
        plans: (plans['in_progress'] ?? 0) + (plans['todo'] ?? 0),
        claims: (raw['in_progress'] as number | undefined) ?? 0,
        assignments: 0,
        runs: 0,
        actions: (raw['attention_required'] as number | undefined) ?? 0,
        agents: (raw['agents'] as number | undefined) ?? 0,
        sessions: (raw['sessions'] as number | undefined) ?? 0,
      },
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
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const fallback = await this._loadFullBoardForProject(normalizedPath);
        if (fallback) {
          this._setSectionBoard(normalizedPath, sectionId, fallback);
          return fallback;
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
    const result = await client.callTool('bclaw_find', { entity, filter });
    return Array.isArray(result.items) ? result.items as T[] : [];
  }

  private async _runSectionBoardLoad(projectPath: string, sectionId: string): Promise<BoardData> {
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
        // Strict live-work filter. Exhaustive exclusion list so pre-v1 states
        // like 'interrupted' / 'timed_out' (which are terminal for all
        // practical purposes) don't render as active work. Anything surviving
        // the filter is genuinely in flight right now.
        const TERMINAL_RUN_STATUSES = new Set([
          'blocked', 'waiting_input', 'failed', 'completed', 'cancelled',
          'interrupted', 'timed_out', 'expired', 'rerouted',
        ]);
        const TERMINAL_ASSIGNMENT_STATUSES = new Set([
          'completed', 'expired', 'rerouted', 'cancelled', 'failed', 'timed_out',
        ]);
        const [claims, assignments, runs] = await Promise.all([
          this._findEntities(client, 'claim', { status: 'active', limit: 100, includeLegacy: true }),
          this._findEntities(client, 'assignment', { limit: 100, includeLegacy: true }),
          this._findEntities(client, 'agent_run', { limit: 100, includeLegacy: true }),
        ]);
        board.active_claims = claims;
        board.active_assignments = assignments.filter((a: any) =>
          !TERMINAL_ASSIGNMENT_STATUSES.has(a.status));
        board.active_runs = runs.filter((run: any) =>
          !TERMINAL_RUN_STATUSES.has(run.status));
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
        const [plans, traps] = await Promise.all([
          this._findEntities(client, 'plan', { limit: 100, includeLegacy: true }),
          this._findEntities(client, 'trap', { status: 'active', limit: 100, includeLegacy: true }),
        ]);
        board.active_plans = plans;
        board.known_traps = traps;
        return board;
      }
      case SECTION.SYSTEM: {
        // Same self-sufficient pattern as BACKLOG. Linked projects + incoming
        // signals still come from the full-board snapshot because they are
        // not reachable via a canonical `bclaw_find` yet — use the cached
        // project board if present and fall back to a one-off load ONLY if
        // nothing is cached (no cascading fire in the common case).
        // runtime_note limit is intentionally large: the filter at render
        // time drops ~99% of them (session-lifecycle noise, agent-runtime
        // tracking). Fetching 200 leaves a realistic number of human-facing
        // notes after filtering. Compaction (pln#436) will trim this at the
        // source eventually.
        const [autoCandidates, runtimeNotes, handoffs] = await Promise.all([
          this._findEntities(client, 'candidate', { status: 'pending', auto_generated: true, limit: 100, includeLegacy: true }),
          this._findEntities(client, 'runtime_note', { limit: 200, includeLegacy: true }),
          this._findEntities(client, 'handoff', { limit: 50, includeLegacy: true }),
        ]);
        board.pending_candidates = autoCandidates;
        board.runtime_notes = runtimeNotes;
        board.open_handoffs = handoffs;
        const cached = this._getBoardForPath(projectPath);
        if (cached && !cached.summary) {
          board.linked_projects = cached.linked_projects ?? [];
          board.incoming_signals = cached.incoming_signals ?? [];
        } else {
          const loadedBoard = await this._loadFullBoardForProject(projectPath);
          if (loadedBoard) {
            board.linked_projects = loadedBoard.linked_projects ?? [];
            board.incoming_signals = loadedBoard.incoming_signals ?? [];
          }
        }
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
    sections.push(new BrainclawTreeItem(
      `Attention required (${attentionCount})`,
      attentionCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      undefined,
      new vscode.ThemeIcon(attentionCount > 0 ? 'bell-dot' : 'bell'),
      undefined,
      undefined,
      undefined,
      projectPath,
      SECTION.ATTENTION,
      'section',
      `section:${projectPath}:${SECTION.ATTENTION}`,
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
    const liveArrayCount = claims.length + runningAssignments.length + activeRunsList.length;
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
    sections.push(new BrainclawTreeItem(
      `System`,
      vscode.TreeItemCollapsibleState.Collapsed,
      systemCount > 0 ? `${systemCount} item(s)` : undefined,
      new vscode.ThemeIcon('server'),
      undefined,
      undefined,
      undefined,
      projectPath,
      SECTION.SYSTEM,
      'section',
      `section:${projectPath}:${SECTION.SYSTEM}`,
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
    return new BrainclawTreeItem(
      label,
      expandWhenPopulated && count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      undefined,
      new vscode.ThemeIcon(icon),
      undefined,
      undefined,
      undefined,
      projectPath,
      sectionId,
      'section',
      `section:${projectPath}:${sectionId}`,
    );
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

    items.push(...this._buildClaims(board, projectPath));

    const runningAssignments = activeAssignments(board).filter((a: any) => a.status !== 'blocked');
    if (runningAssignments.length > 0) {
      items.push(...this._buildAssignmentItems(runningAssignments, projectPath));
    }

    const activeRunsList = activeRuns(board).filter((r: any) => r.status !== 'blocked' && r.status !== 'waiting_input' && r.status !== 'failed');
    if (activeRunsList.length > 0) {
      items.push(...this._buildRunItems(activeRunsList, projectPath));
    }

    if (items.length === 0) return [this._emptyLeaf('No active claims, assignments, or runs')];
    return items;
  }

  private _buildBacklogChildren(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const items: BrainclawTreeItem[] = [];

    const backlogPlans = activePlans(board).filter((p: any) => p.status === 'in_progress' || p.status === 'todo');
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
      );
    });
  }

  private _buildPlanItems(plans: any[], projectPath: string): BrainclawTreeItem[] {
    return plans.map((plan: any) => {
      const assignee = plan.assignee ? ` @${plan.assignee}` : '';
      const stepsInfo = plan.steps?.length ? ` [${plan.steps.filter((step: any) => step.status === 'done').length}/${plan.steps.length}]` : '';
      const icon = plan.status === 'in_progress' ? 'play-circle' : plan.status === 'blocked' ? 'error' : 'circle-outline';
      const summary = `[${plan.id}] ${plan.text}\nStatus: ${plan.status}\nPriority: ${plan.priority ?? 'medium'}${assignee}${stepsInfo}`;
      const item = new BrainclawTreeItem(
        plan.text?.slice(0, 80) ?? plan.id,
        vscode.TreeItemCollapsibleState.None,
        `${plan.status} · ${plan.priority ?? 'medium'}${assignee}${stepsInfo}`,
        new vscode.ThemeIcon(icon),
        summary,
        'plan',
        plan.id,
        projectPath,
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
      const item = new BrainclawTreeItem(
        claim.scope,
        vscode.TreeItemCollapsibleState.None,
        `by ${claim.agent} · ${ago}`,
        new vscode.ThemeIcon('shield'),
        summary,
        'claim',
        claim.id,
        projectPath,
      );
      attachEntityPreview(item, 'claim', claim.id, projectPath, summary);
      return item;
    });
  }

  private _buildAssignmentItems(assignments: any[], projectPath: string): BrainclawTreeItem[] {
    return assignments.map((assignment: any) => {
      const heartbeatAgo = assignment.last_heartbeat_at ? timeAgo(assignment.last_heartbeat_at) : 'no heartbeat yet';
      const icon = assignment.status === 'started'
        ? 'play-circle'
        : assignment.status === 'accepted'
          ? 'check'
          : assignment.status === 'offered'
            ? 'mail'
            : assignment.status === 'blocked'
              ? 'warning'
              : 'circle-outline';
      const label = assignment.description?.slice(0, 80) || assignment.scope || assignment.id;
      const plan = assignment.plan_id ? `\nPlan: ${assignment.plan_id}` : '';

      return new BrainclawTreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
        `${assignment.status} · ${assignment.agent} · ${heartbeatAgo}`,
        new vscode.ThemeIcon(icon),
        `Assignment: ${assignment.id}\nAgent: ${assignment.agent}\nStatus: ${assignment.status}\nScope: ${assignment.scope}${plan}\nLast heartbeat: ${heartbeatAgo}`,
        'assignment',
        assignment.id,
        projectPath,
      );
    });
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
      return new BrainclawTreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
        `${run.status} · ${run.transport} · ${ago}`,
        new vscode.ThemeIcon(icon),
        `Run: ${run.id}\nAssignment: ${run.assignment_id}\nAgent: ${run.agent}\nStatus: ${run.status}\nTransport: ${run.transport}\nAttempt: ${run.attempt_index}\nScope: ${run.scope}\nLast event: ${ago}`,
        'run',
        run.id,
        projectPath,
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
      const item = new BrainclawTreeItem(
        trap.text?.slice(0, 80) ?? trap.id,
        vscode.TreeItemCollapsibleState.None,
        trap.severity,
        new vscode.ThemeIcon(icon),
        summary,
        'trap',
        trap.id,
        projectPath,
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
      ));
    }

    if (items.length === 0) {
      items.push(new BrainclawTreeItem('No linked projects', vscode.TreeItemCollapsibleState.None));
    }

    return items;
  }
}

function canRunCommand(command: string, cwd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    cp.exec(command, { cwd, timeout: 3000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

export async function resolveBrainclawCmd(cwd: string): Promise<string | undefined> {
  const local = path.join(cwd, 'node_modules', '.bin', 'brainclaw');
  if (await canRunCommand(`"${local}" --version`, cwd)) {
    return `"${local}"`;
  }

  const distCli = path.join(cwd, 'dist', 'cli.js');
  if (await canRunCommand(`node "${distCli}" --version`, cwd)) {
    return `node "${distCli}"`;
  }

  if (await canRunCommand('brainclaw --version', cwd)) {
    return 'brainclaw';
  }

  return undefined;
}
