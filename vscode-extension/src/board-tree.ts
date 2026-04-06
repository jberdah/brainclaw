import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

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
    public readonly tooltip?: string,
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
    if (tooltip) this.tooltip = tooltip;
    if (contextValue) this.contextValue = contextValue;
    if (treeId) this.id = treeId;
  }
}

interface BoardData {
  active_plans: any[];
  active_claims: any[];
  open_handoffs: any[];
  runtime_notes: any[];
  other_agents?: any[];
  active_sequence?: any;
  known_traps?: any[];
  pending_candidates?: any[];
  linked_projects?: any[];
  incoming_signals?: any[];
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type Freshness = 'active' | 'idle' | 'stale';

function agentFreshness(agent: any): Freshness {
  if (agent.has_open_session || agent.claim_count > 0) return 'active';
  if (!agent.last_active) return 'stale';
  const hours = (Date.now() - new Date(agent.last_active).getTime()) / 3600000;
  if (hours < 1) return 'active';
  if (hours < 6) return 'idle';
  return 'stale';
}

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
  return board.active_claims ?? [];
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
  AGENTS: 'agents',
  CANDIDATES: 'candidates',
  ACTIVITY: 'activity',
  PLANS: 'plans',
  CLAIMS: 'claims',
  HANDOFFS: 'handoffs',
  SPRINT: 'sprint',
  TRAPS: 'traps',
  CROSS_PROJECT: 'cross-project',
} as const;

export class BrainclawBoardProvider implements vscode.TreeDataProvider<BrainclawTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BrainclawTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _workspaceRoot: string;
  private readonly _projects: BoardProject[];
  private readonly _projectIndex = new Map<string, BoardProject>();
  private readonly _rootProjectPath?: string;

  private readonly _watchers = new Map<string, cp.ChildProcess>();
  private readonly _projectBoards = new Map<string, BoardData | null>();
  private readonly _projectErrors = new Map<string, string>();
  private readonly _loadPromises = new Map<string, Promise<BoardData | null>>();
  private readonly _loadingProjects = new Set<string>();
  private readonly _resolvedCmds = new Map<string, string | null>();

  private _workspaceBoard: BoardData | null = null;
  private _refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(workspaceRoot: string, projects: BoardProject[]) {
    this._workspaceRoot = this._normalizePath(workspaceRoot);
    this._projects = this._dedupeProjects(projects);
    for (const project of this._projects) {
      this._projectIndex.set(project.path, project);
    }
    this._rootProjectPath = this._projects.find((project) => project.path === this._workspaceRoot)?.path;

    setTimeout(() => {
      this.refresh();
      this._startWatches();
    }, 0);
  }

  public refresh(): void {
    void this._refreshBoards();
  }

  public exec(command: string, cwd?: string): void {
    const targetCwd = this._normalizePath(cwd ?? this._rootProjectPath ?? this._workspaceRoot);
    const bclaw = this._resolveCmd(targetCwd);
    if (!bclaw) {
      vscode.window.showErrorMessage('Brainclaw: no brainclaw command found');
      return;
    }

    cp.exec(`${bclaw} ${command}`, { cwd: targetCwd }, (err) => {
      if (err) {
        vscode.window.showErrorMessage(`Brainclaw: ${err.message}`);
      }
      this.refresh();
    });
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

    this._onDidChangeTreeData.fire();
  }

  private _debouncedRefresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refresh(), 500);
  }

  dispose(): void {
    for (const watcher of this._watchers.values()) {
      watcher.kill();
    }
    this._watchers.clear();
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
  }

  private _resolveCmd(cwd: string): string | undefined {
    const normalizedPath = this._normalizePath(cwd);
    if (this._resolvedCmds.has(normalizedPath)) {
      const resolved = this._resolvedCmds.get(normalizedPath);
      return resolved ?? undefined;
    }

    const resolved = resolveBrainclawCmd(normalizedPath) ?? null;
    this._resolvedCmds.set(normalizedPath, resolved);
    return resolved ?? undefined;
  }

  private _startWatches(): void {
    for (const project of this._projects) {
      this._startWatch(project.path);
    }
  }

  private _startWatch(projectPath: string): void {
    const normalizedPath = this._normalizePath(projectPath);
    if (this._watchers.has(normalizedPath)) return;

    const bclaw = this._resolveCmd(normalizedPath);
    if (!bclaw) return;

    const watcher = cp.spawn(`${bclaw} watch`, [], { cwd: normalizedPath, shell: true });
    watcher.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if ([
            'added',
            'changed',
            'removed',
            'plan_added',
            'constraint_added',
            'claim_created',
            'claim_released',
            'handoff_added',
            'decision_added',
          ].includes(event.event)) {
            this._debouncedRefresh();
          }
        } catch {
          // ignore non-JSON watch output
        }
      }
    });
    watcher.on('exit', () => {
      this._watchers.delete(normalizedPath);
    });
    this._watchers.set(normalizedPath, watcher);
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
        if (normalizedPath === this._rootProjectPath) {
          this._workspaceBoard = board;
        }
        return board;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this._projectBoards.delete(normalizedPath);
        this._projectErrors.set(normalizedPath, message);
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

  private _runAgentBoard(projectPath: string): Promise<BoardData> {
    const bclaw = this._resolveCmd(projectPath);
    if (!bclaw) {
      return Promise.reject(new Error(`No brainclaw command found for ${projectPath}`));
    }

    return new Promise<BoardData>((resolve, reject) => {
      cp.exec(`${bclaw} agent-board --all-agents --json`, { cwd: projectPath, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }

        try {
          resolve(JSON.parse(stdout) as BoardData);
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
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

  private _projectSummary(board: BoardData): { plans: number; claims: number; agents: number; sessions: number } {
    return {
      plans: activePlans(board).length,
      claims: activeClaims(board).length,
      agents: workingAgents(board).length,
      sessions: openSessions(board),
    };
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
      if (!board) {
        if (!this._loadingProjects.has(this._normalizePath(element.projectPath))) {
          void this._loadBoardForProject(element.projectPath, false, true);
        }
        return [new BrainclawTreeItem('Loading board...', vscode.TreeItemCollapsibleState.None, undefined, new vscode.ThemeIcon('sync~spin'))];
      }
      return this._buildSectionChildren(element.sectionId, board, element.projectPath);
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

    if (this._workspaceBoard && this._rootProjectPath) {
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
        description = `${summary.plans} plans · ${summary.claims} claims · ${summary.agents} agents · ${summary.sessions} sessions`;
        tooltip += `\nActive plans: ${summary.plans}\nActive claims: ${summary.claims}\nAgents working: ${summary.agents}\nOpen sessions: ${summary.sessions}`;
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
      const project = this._getProject(normalizedPath);
      const error = this._projectErrors.get(normalizedPath);
      return [new BrainclawTreeItem(
        error ? `Unable to load ${project?.name ?? 'project'} board` : 'Loading project board...',
        vscode.TreeItemCollapsibleState.None,
        error,
        new vscode.ThemeIcon(error ? 'error' : 'sync~spin'),
      )];
    }

    return this._buildBoardSections(board, normalizedPath, false);
  }

  private _buildBoardSections(board: BoardData, projectPath: string, expandWhenPopulated: boolean): BrainclawTreeItem[] {
    const sections: BrainclawTreeItem[] = [];

    const agents = board.other_agents ?? [];
    sections.push(this._sectionHeader(`Agents (${agents.length})`, SECTION.AGENTS, 'pulse', agents.length, projectPath, expandWhenPopulated));

    const candidates = board.pending_candidates ?? [];
    if (candidates.length > 0) {
      sections.push(this._sectionHeader(`Review Queue (${candidates.length})`, SECTION.CANDIDATES, 'inbox', candidates.length, projectPath, expandWhenPopulated));
    }

    const notes = board.runtime_notes ?? [];
    if (notes.length > 0) {
      sections.push(this._sectionHeader(`Activity (${Math.min(notes.length, 10)})`, SECTION.ACTIVITY, 'history', notes.length, projectPath, expandWhenPopulated));
    }

    const plans = activePlans(board);
    sections.push(this._sectionHeader(`Plans (${plans.length})`, SECTION.PLANS, 'tasklist', plans.length, projectPath, expandWhenPopulated));

    const claims = activeClaims(board);
    if (claims.length > 0) {
      sections.push(this._sectionHeader(`Claims (${claims.length})`, SECTION.CLAIMS, 'lock', claims.length, projectPath, expandWhenPopulated));
    }

    const handoffs = visibleHandoffs(board);
    if (handoffs.length > 0) {
      sections.push(this._sectionHeader(`Handoffs (${handoffs.length})`, SECTION.HANDOFFS, 'arrow-swap', handoffs.length, projectPath, expandWhenPopulated));
    }

    if (board.active_sequence) {
      const total = board.active_sequence.items?.length ?? 0;
      sections.push(this._sectionHeader(`Sprint (${board.active_sequence.name})`, SECTION.SPRINT, 'rocket', total, projectPath, expandWhenPopulated));
    }

    const traps = board.known_traps ?? [];
    if (traps.length > 0) {
      const highCount = traps.filter((trap: any) => trap.severity === 'high').length;
      const label = highCount > 0 ? `Traps (${highCount} high, ${traps.length} total)` : `Traps (${traps.length})`;
      sections.push(this._sectionHeader(label, SECTION.TRAPS, 'warning', traps.length, projectPath, expandWhenPopulated));
    }

    const linked = board.linked_projects ?? [];
    const signals = board.incoming_signals ?? [];
    if (linked.length > 0 || signals.length > 0) {
      sections.push(this._sectionHeader(`Cross-Project (${linked.length})`, SECTION.CROSS_PROJECT, 'globe', linked.length + signals.length, projectPath, expandWhenPopulated));
    }

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
      case SECTION.AGENTS: return this._buildAgents(board, projectPath);
      case SECTION.CANDIDATES: return this._buildCandidates(board, projectPath);
      case SECTION.ACTIVITY: return this._buildActivity(board, projectPath);
      case SECTION.PLANS: return this._buildPlans(board, projectPath);
      case SECTION.CLAIMS: return this._buildClaims(board, projectPath);
      case SECTION.HANDOFFS: return this._buildHandoffs(board, projectPath);
      case SECTION.SPRINT: return this._buildSprint(board, projectPath);
      case SECTION.TRAPS: return this._buildTraps(board, projectPath);
      case SECTION.CROSS_PROJECT: return this._buildCrossProject(board, projectPath);
      default: return [];
    }
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

      return new BrainclawTreeItem(
        agent.name,
        vscode.TreeItemCollapsibleState.None,
        desc,
        freshnessIcon(freshness),
        `Agent: ${agent.name}\nTrust: ${agent.trust_level}\nClaims: ${agent.claim_count}\nScopes: ${scopeList || 'none'}\nLast active: ${ago}\nSession: ${agent.has_open_session ? 'open' : 'closed'}`,
        undefined,
        undefined,
        projectPath,
      );
    });
  }

  private _buildCandidates(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const candidates = board.pending_candidates ?? [];
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

  private _buildActivity(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const notes = (board.runtime_notes ?? []).slice(-10).reverse();
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

  private _buildPlans(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const plans = activePlans(board);
    if (plans.length === 0) {
      return [new BrainclawTreeItem('No active plans', vscode.TreeItemCollapsibleState.None)];
    }

    return plans.map((plan: any) => {
      const assignee = plan.assignee ? ` @${plan.assignee}` : '';
      const stepsInfo = plan.steps?.length ? ` [${plan.steps.filter((step: any) => step.status === 'done').length}/${plan.steps.length}]` : '';
      const icon = plan.status === 'in_progress' ? 'play-circle' : plan.status === 'blocked' ? 'error' : 'circle-outline';
      return new BrainclawTreeItem(
        plan.text?.slice(0, 80) ?? plan.id,
        vscode.TreeItemCollapsibleState.None,
        `${plan.status} · ${plan.priority ?? 'medium'}${assignee}${stepsInfo}`,
        new vscode.ThemeIcon(icon),
        `[${plan.id}] ${plan.text}\nStatus: ${plan.status}\nPriority: ${plan.priority ?? 'medium'}${assignee}${stepsInfo}`,
        'plan',
        plan.id,
        projectPath,
      );
    });
  }

  private _buildClaims(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const claims = activeClaims(board);
    return claims.map((claim: any) => {
      const ago = claim.created_at ? timeAgo(claim.created_at) : '';
      return new BrainclawTreeItem(
        claim.scope,
        vscode.TreeItemCollapsibleState.None,
        `by ${claim.agent} · ${ago}`,
        new vscode.ThemeIcon('shield'),
        `Claimed by: ${claim.agent}\nScope: ${claim.scope}\nDescription: ${claim.description ?? ''}\nSince: ${ago}`,
        'claim',
        claim.id,
        projectPath,
      );
    });
  }

  private _buildHandoffs(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    return visibleHandoffs(board).map((handoff: any) => new BrainclawTreeItem(
      handoff.text?.slice(0, 80) ?? handoff.id,
      vscode.TreeItemCollapsibleState.None,
      `${handoff.from ?? '?'} → ${handoff.to ?? '?'}`,
      new vscode.ThemeIcon('arrow-swap'),
      `From: ${handoff.from}\nTo: ${handoff.to}\n${handoff.text}`,
      undefined,
      undefined,
      projectPath,
    ));
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

  private _buildTraps(board: BoardData, projectPath: string): BrainclawTreeItem[] {
    const traps = board.known_traps ?? [];
    return traps.map((trap: any) => {
      const icon = trap.severity === 'high' ? 'error' : trap.severity === 'medium' ? 'warning' : 'info';
      return new BrainclawTreeItem(
        trap.text?.slice(0, 80) ?? trap.id,
        vscode.TreeItemCollapsibleState.None,
        trap.severity,
        new vscode.ThemeIcon(icon),
        `[${trap.severity}] ${trap.text}`,
        undefined,
        undefined,
        projectPath,
      );
    });
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

export function resolveBrainclawCmd(cwd: string): string | undefined {
  const opts = { stdio: 'ignore' as const, timeout: 3000 };

  const local = path.join(cwd, 'node_modules', '.bin', 'brainclaw');
  try {
    cp.execSync(`"${local}" --version`, opts);
    return `"${local}"`;
  } catch {
    // ignore
  }

  const distCli = path.join(cwd, 'dist', 'cli.js');
  try {
    cp.execSync(`node "${distCli}" --version`, opts);
    return `node "${distCli}"`;
  } catch {
    // ignore
  }

  try {
    cp.execSync('brainclaw --version', opts);
    return 'brainclaw';
  } catch {
    // ignore
  }

  return undefined;
}
