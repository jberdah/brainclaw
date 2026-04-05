import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

// --- Tree item with metadata for context menus ---

export class BrainclawTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly iconPath?: vscode.ThemeIcon | string | vscode.Uri,
    public readonly tooltip?: string,
    public readonly contextValue?: string,
    public readonly itemId?: string,
  ) {
    super(label, collapsibleState);
    if (description) this.description = description;
    if (iconPath) this.iconPath = iconPath;
    if (tooltip) this.tooltip = tooltip;
    if (contextValue) this.contextValue = contextValue;
  }
}

// --- Board data shape (from brainclaw agent-board --json) ---

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

// --- Time helpers ---

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
  // Active = has open session OR active claims OR last activity < 1h
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

// --- Section IDs for getChildren routing ---

const SECTION = {
  AGENTS: 'section:agents',
  CANDIDATES: 'section:candidates',
  ACTIVITY: 'section:activity',
  PLANS: 'section:plans',
  CLAIMS: 'section:claims',
  HANDOFFS: 'section:handoffs',
  SPRINT: 'section:sprint',
  TRAPS: 'section:traps',
  CROSS_PROJECT: 'section:cross-project',
} as const;

// --- Provider ---

export class BrainclawBoardProvider implements vscode.TreeDataProvider<BrainclawTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BrainclawTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _watcher?: cp.ChildProcess;
  private _board: BoardData | null = null;
  private _refreshTimer?: ReturnType<typeof setTimeout>;
  private _resolvedCmd: string | undefined | null = null;

  constructor(private readonly _cwd: string) {
    setTimeout(() => this._startWatch(), 0);
  }

  public refresh(): void {
    const bclaw = this._resolveCmd();
    if (!bclaw) {
      console.warn('[brainclaw] No brainclaw command found');
      return;
    }
    cp.exec(`${bclaw} agent-board --all-agents --json`, { cwd: this._cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        console.error('[brainclaw] agent-board failed:', err.message);
        return;
      }
      if (stdout) {
        try {
          this._board = JSON.parse(stdout);
          this._onDidChangeTreeData.fire();
        } catch (e) {
          console.error('[brainclaw] JSON parse error:', (e as Error).message);
        }
      }
    });
  }

  /** Run a brainclaw CLI command and refresh the board after. */
  public exec(command: string): void {
    const bclaw = this._resolveCmd();
    if (!bclaw) return;
    cp.exec(`${bclaw} ${command}`, { cwd: this._cwd }, (err) => {
      if (err) {
        vscode.window.showErrorMessage(`Brainclaw: ${err.message}`);
      }
      this.refresh();
    });
  }

  private _debouncedRefresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refresh(), 500);
  }

  dispose() {
    this._watcher?.kill();
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
  }

  private _resolveCmd(): string | undefined {
    if (this._resolvedCmd === null) {
      this._resolvedCmd = resolveBrainclawCmd(this._cwd);
    }
    return this._resolvedCmd;
  }

  private _startWatch() {
    const bclaw = this._resolveCmd();
    if (!bclaw) return;
    this.refresh();
    this._watcher = cp.spawn(`${bclaw} watch`, [], { cwd: this._cwd, shell: true });
    this._watcher.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (['added', 'changed', 'removed', 'plan_added', 'constraint_added',
               'claim_created', 'claim_released', 'handoff_added', 'decision_added'
          ].includes(event.event)) {
            this._debouncedRefresh();
          }
        } catch { }
      }
    });
  }

  getTreeItem(element: BrainclawTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BrainclawTreeItem): Thenable<BrainclawTreeItem[]> {
    if (!this._board) {
      return Promise.resolve([new BrainclawTreeItem('Loading board...', vscode.TreeItemCollapsibleState.None)]);
    }

    // Root: section headers
    if (!element) {
      return Promise.resolve(this._buildSections());
    }

    // Children by section
    const id = element.contextValue;
    switch (id) {
      case SECTION.AGENTS: return Promise.resolve(this._buildAgents());
      case SECTION.CANDIDATES: return Promise.resolve(this._buildCandidates());
      case SECTION.ACTIVITY: return Promise.resolve(this._buildActivity());
      case SECTION.PLANS: return Promise.resolve(this._buildPlans());
      case SECTION.CLAIMS: return Promise.resolve(this._buildClaims());
      case SECTION.HANDOFFS: return Promise.resolve(this._buildHandoffs());
      case SECTION.SPRINT: return Promise.resolve(this._buildSprint());
      case SECTION.TRAPS: return Promise.resolve(this._buildTraps());
      case SECTION.CROSS_PROJECT: return Promise.resolve(this._buildCrossProject());
      default: return Promise.resolve([]);
    }
  }

  // ─── Section builders ──────────────────────────────────────────

  private _buildSections(): BrainclawTreeItem[] {
    const b = this._board!;
    const sections: BrainclawTreeItem[] = [];

    // Agents actifs
    const agents = b.other_agents ?? [];
    sections.push(this._sectionHeader(`Agents (${agents.length})`, SECTION.AGENTS, 'pulse', agents.length));

    // Candidates
    const candidates = b.pending_candidates ?? [];
    if (candidates.length > 0) {
      sections.push(this._sectionHeader(`Review Queue (${candidates.length})`, SECTION.CANDIDATES, 'inbox', candidates.length));
    }

    // Activity
    const notes = b.runtime_notes ?? [];
    if (notes.length > 0) {
      sections.push(this._sectionHeader(`Activity (${Math.min(notes.length, 10)})`, SECTION.ACTIVITY, 'history', notes.length));
    }

    // Plans
    const plans = b.active_plans?.filter((p: any) => p.status !== 'done' && p.status !== 'dropped') ?? [];
    sections.push(this._sectionHeader(`Plans (${plans.length})`, SECTION.PLANS, 'tasklist', plans.length));

    // Claims
    const claims = b.active_claims ?? [];
    if (claims.length > 0) {
      sections.push(this._sectionHeader(`Claims (${claims.length})`, SECTION.CLAIMS, 'lock', claims.length));
    }

    // Handoffs (filter out auto-generated session handoffs — noise for human supervisors)
    const handoffs = (b.open_handoffs ?? [])
      .filter((h: any) => h.status !== 'closed')
      .filter((h: any) => !h.text?.startsWith('Session sess_'));
    if (handoffs.length > 0) {
      sections.push(this._sectionHeader(`Handoffs (${handoffs.length})`, SECTION.HANDOFFS, 'arrow-swap', handoffs.length));
    }

    // Sprint
    if (b.active_sequence) {
      const total = b.active_sequence.items?.length ?? 0;
      sections.push(this._sectionHeader(`Sprint (${b.active_sequence.name})`, SECTION.SPRINT, 'rocket', total));
    }

    // Traps
    const traps = b.known_traps ?? [];
    if (traps.length > 0) {
      const highCount = traps.filter((t: any) => t.severity === 'high').length;
      const label = highCount > 0 ? `Traps (${highCount} high, ${traps.length} total)` : `Traps (${traps.length})`;
      sections.push(this._sectionHeader(label, SECTION.TRAPS, 'warning', traps.length));
    }

    // Cross-project
    const linked = b.linked_projects ?? [];
    const signals = b.incoming_signals ?? [];
    if (linked.length > 0 || signals.length > 0) {
      sections.push(this._sectionHeader(`Cross-Project (${linked.length})`, SECTION.CROSS_PROJECT, 'globe', linked.length + signals.length));
    }

    return sections;
  }

  private _sectionHeader(label: string, contextValue: string, icon: string, count: number): BrainclawTreeItem {
    return new BrainclawTreeItem(
      label,
      count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      undefined,
      new vscode.ThemeIcon(icon),
      undefined,
      contextValue,
    );
  }

  // ─── Agents actifs ─────────────────────────────────────────────

  private _buildAgents(): BrainclawTreeItem[] {
    const agents = this._board?.other_agents ?? [];
    if (agents.length === 0) {
      return [new BrainclawTreeItem('No agents registered', vscode.TreeItemCollapsibleState.None, undefined, new vscode.ThemeIcon('info'))];
    }
    // Sort: active first, then idle, then stale
    const sorted = [...agents].sort((a: any, b: any) => {
      const order = { active: 0, idle: 1, stale: 2 };
      return (order[agentFreshness(a)] ?? 3) - (order[agentFreshness(b)] ?? 3);
    });
    return sorted.map((a: any) => {
      const freshness = agentFreshness(a);
      const ago = a.last_active ? timeAgo(a.last_active) : 'never';
      const session = a.has_open_session ? ' · session open' : '';
      const claims = a.claim_count > 0 ? ` · ${a.claim_count} claim(s)` : '';
      const desc = freshness === 'stale' ? `${a.trust_level} · ${ago}` : `${a.trust_level}${claims}${session} · ${ago}`;
      const scopeList = (a.scopes ?? []).join(', ');
      return new BrainclawTreeItem(
        a.name,
        vscode.TreeItemCollapsibleState.None,
        desc,
        freshnessIcon(freshness),
        `Agent: ${a.name}\nTrust: ${a.trust_level}\nClaims: ${a.claim_count}\nScopes: ${scopeList || 'none'}\nLast active: ${ago}\nSession: ${a.has_open_session ? 'open' : 'closed'}`,
      );
    });
  }

  // ─── Candidates à reviewer ─────────────────────────────────────

  private _buildCandidates(): BrainclawTreeItem[] {
    const candidates = this._board?.pending_candidates ?? [];
    return candidates.map((c: any) => {
      const age = c.created_at ? timeAgo(c.created_at) : '';
      const overdue = c.overdue ? ' OVERDUE' : '';
      return new BrainclawTreeItem(
        c.text?.slice(0, 80) ?? c.id,
        vscode.TreeItemCollapsibleState.None,
        `${c.type} by ${c.author ?? '?'} · ${age}${overdue}`,
        new vscode.ThemeIcon(c.overdue ? 'bell-dot' : 'comment-discussion'),
        `[${c.id}] ${c.type}\n${c.text}\nBy: ${c.author ?? 'unknown'}\nAge: ${age}${overdue}`,
        'candidate',
        c.id,
      );
    });
  }

  // ─── Activité récente ──────────────────────────────────────────

  private _buildActivity(): BrainclawTreeItem[] {
    const notes = (this._board?.runtime_notes ?? []).slice(-10).reverse();
    return notes.map((n: any) => {
      const ago = n.created_at ? timeAgo(n.created_at) : '';
      return new BrainclawTreeItem(
        n.text?.slice(0, 80) ?? 'note',
        vscode.TreeItemCollapsibleState.None,
        `${n.agent} · ${ago}`,
        new vscode.ThemeIcon('comment'),
        `[${n.id}] ${n.agent}\n${n.text}\n${ago}`,
      );
    });
  }

  // ─── Plans ─────────────────────────────────────────────────────

  private _buildPlans(): BrainclawTreeItem[] {
    const plans = (this._board?.active_plans ?? [])
      .filter((p: any) => p.status !== 'done' && p.status !== 'dropped');
    if (plans.length === 0) {
      return [new BrainclawTreeItem('No active plans', vscode.TreeItemCollapsibleState.None)];
    }
    return plans.map((p: any) => {
      const assignee = p.assignee ? ` @${p.assignee}` : '';
      const stepsInfo = p.steps?.length ? ` [${p.steps.filter((s: any) => s.status === 'done').length}/${p.steps.length}]` : '';
      const icon = p.status === 'in_progress' ? 'play-circle' : p.status === 'blocked' ? 'error' : 'circle-outline';
      return new BrainclawTreeItem(
        p.text?.slice(0, 80) ?? p.id,
        vscode.TreeItemCollapsibleState.None,
        `${p.status} · ${p.priority ?? 'medium'}${assignee}${stepsInfo}`,
        new vscode.ThemeIcon(icon),
        `[${p.id}] ${p.text}\nStatus: ${p.status}\nPriority: ${p.priority ?? 'medium'}${assignee}${stepsInfo}`,
        'plan',
        p.id,
      );
    });
  }

  // ─── Claims ────────────────────────────────────────────────────

  private _buildClaims(): BrainclawTreeItem[] {
    const claims = this._board?.active_claims ?? [];
    return claims.map((c: any) => {
      const ago = c.created_at ? timeAgo(c.created_at) : '';
      return new BrainclawTreeItem(
        c.scope,
        vscode.TreeItemCollapsibleState.None,
        `by ${c.agent} · ${ago}`,
        new vscode.ThemeIcon('shield'),
        `Claimed by: ${c.agent}\nScope: ${c.scope}\nDescription: ${c.description ?? ''}\nSince: ${ago}`,
        'claim',
        c.id,
      );
    });
  }

  // ─── Handoffs ──────────────────────────────────────────────────

  private _buildHandoffs(): BrainclawTreeItem[] {
    const handoffs = (this._board?.open_handoffs ?? [])
      .filter((h: any) => h.status !== 'closed')
      .filter((h: any) => !h.text?.startsWith('Session sess_')); // skip auto-generated session handoffs
    return handoffs.map((h: any) => new BrainclawTreeItem(
      h.text?.slice(0, 80) ?? h.id,
      vscode.TreeItemCollapsibleState.None,
      `${h.from ?? '?'} → ${h.to ?? '?'}`,
      new vscode.ThemeIcon('arrow-swap'),
      `From: ${h.from}\nTo: ${h.to}\n${h.text}`,
    ));
  }

  // ─── Sprint progress ──────────────────────────────────────────

  private _buildSprint(): BrainclawTreeItem[] {
    const seq = this._board?.active_sequence;
    if (!seq?.items) return [];

    // Resolve plan status for each sequence item
    const planMap = new Map<string, any>();
    for (const p of this._board?.active_plans ?? []) {
      planMap.set(p.id, p);
    }

    const items = seq.items as any[];
    const doneCount = items.filter((item: any) => {
      const plan = planMap.get(item.planId);
      return plan?.status === 'done';
    }).length;

    const progressBar = this._renderProgressBar(doneCount, items.length);
    const result: BrainclawTreeItem[] = [
      new BrainclawTreeItem(progressBar, vscode.TreeItemCollapsibleState.None, `${doneCount}/${items.length} done`, new vscode.ThemeIcon('graph')),
    ];

    for (const item of items) {
      const plan = planMap.get(item.planId);
      const status = plan?.status ?? 'unknown';
      const icon = status === 'done' ? 'pass' : status === 'in_progress' ? 'play-circle' : 'circle-outline';
      const lane = item.lane ? `[${item.lane}] ` : '';
      const text = plan?.text?.slice(0, 60) ?? item.planId;
      result.push(new BrainclawTreeItem(
        `#${item.rank} ${lane}${text}`,
        vscode.TreeItemCollapsibleState.None,
        status,
        new vscode.ThemeIcon(icon),
      ));
    }

    return result;
  }

  private _renderProgressBar(done: number, total: number): string {
    if (total === 0) return '[ empty ]';
    const filled = Math.round((done / total) * 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${Math.round((done / total) * 100)}%`;
  }

  // ─── Traps ─────────────────────────────────────────────────────

  private _buildTraps(): BrainclawTreeItem[] {
    const traps = this._board?.known_traps ?? [];
    return traps.map((t: any) => {
      const icon = t.severity === 'high' ? 'error' : t.severity === 'medium' ? 'warning' : 'info';
      return new BrainclawTreeItem(
        t.text?.slice(0, 80) ?? t.id,
        vscode.TreeItemCollapsibleState.None,
        t.severity,
        new vscode.ThemeIcon(icon),
        `[${t.severity}] ${t.text}`,
      );
    });
  }

  // ─── Cross-project ─────────────────────────────────────────────

  private _buildCrossProject(): BrainclawTreeItem[] {
    const items: BrainclawTreeItem[] = [];

    const linked = this._board?.linked_projects ?? [];
    for (const lp of linked) {
      const status = lp.available ? 'available' : 'unavailable';
      const agents = lp.agents?.length > 0 ? lp.agents.join(', ') : 'no agents';
      items.push(new BrainclawTreeItem(
        lp.name,
        vscode.TreeItemCollapsibleState.None,
        `${lp.role} · ${lp.active_plans} plans · ${lp.active_claims} claims · ${agents}`,
        new vscode.ThemeIcon(lp.available ? 'remote' : 'remote-explorer'),
        `Project: ${lp.name}\nRole: ${lp.role}\nStatus: ${status}\nPlans: ${lp.active_plans}\nClaims: ${lp.active_claims}\nAgents: ${agents}`,
      ));
    }

    const signals = this._board?.incoming_signals ?? [];
    for (const sig of signals) {
      const ago = sig.created_at ? timeAgo(sig.created_at) : '';
      items.push(new BrainclawTreeItem(
        sig.preview?.slice(0, 80) ?? sig.id,
        vscode.TreeItemCollapsibleState.None,
        `${sig.entity_type} from ${sig.from_project}/${sig.from_agent} · ${ago}`,
        new vscode.ThemeIcon('mail'),
        `Signal: ${sig.entity_type}\nFrom: ${sig.from_project} / ${sig.from_agent}\n${sig.preview}`,
      ));
    }

    if (items.length === 0) {
      items.push(new BrainclawTreeItem('No linked projects', vscode.TreeItemCollapsibleState.None));
    }

    return items;
  }
}

// --- Brainclaw binary resolution ---

export function resolveBrainclawCmd(cwd: string): string | undefined {
  const opts = { stdio: 'ignore' as const, timeout: 3000 };

  const local = path.join(cwd, 'node_modules', '.bin', 'brainclaw');
  try {
    cp.execSync(`"${local}" --version`, opts);
    return `"${local}"`;
  } catch { }

  const distCli = path.join(cwd, 'dist', 'cli.js');
  try {
    cp.execSync(`node "${distCli}" --version`, opts);
    return `node "${distCli}"`;
  } catch { }

  try {
    cp.execSync('brainclaw --version', opts);
    return 'brainclaw';
  } catch { }
  return undefined;
}
