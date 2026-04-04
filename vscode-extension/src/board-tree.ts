import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export class BrainclawTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly iconPath?: vscode.ThemeIcon | string | vscode.Uri,
    public readonly tooltip?: string
  ) {
    super(label, collapsibleState);
    if (description) this.description = description;
    if (iconPath) this.iconPath = iconPath;
    if (tooltip) this.tooltip = tooltip;
  }
}

export class BrainclawBoardProvider implements vscode.TreeDataProvider<BrainclawTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<BrainclawTreeItem | undefined | void> = new vscode.EventEmitter<BrainclawTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<BrainclawTreeItem | undefined | void> = this._onDidChangeTreeData.event;
  
  private _watcher?: cp.ChildProcess;
  private _board: any = null;
  private _refreshTimer?: ReturnType<typeof setTimeout>;

  private _resolvedCmd: string | undefined | null = null; // null = not yet resolved

  constructor(private readonly _cwd: string) {
    // Defer to avoid blocking extension host activation
    setTimeout(() => this._startWatch(), 0);
  }

  public refresh(): void {
    const bclaw = this._resolveCmd();
    if (!bclaw) {
      console.warn('[brainclaw] No brainclaw command found');
      return;
    }
    const cmd = `${bclaw} agent-board --json`;
    cp.exec(cmd, { cwd: this._cwd }, (err: cp.ExecException | null, stdout: string, stderr: string) => {
      if (err) {
        console.error(`[brainclaw] ${cmd} failed:`, stderr || err.message);
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

  /** Debounced refresh — collapses rapid NDJSON events into a single exec. */
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

    this.refresh(); // Initial load

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
        } catch { } // skip malformed
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

    if (!element) {
      // Root nodes
      const plans = (this._board.plans as any[])?.filter((p: any) => p.status !== 'done' && p.status !== 'dropped') ?? [];
      const claims = this._board.active_claims ?? [];
      const handoffs = (this._board.open_handoffs as any[])?.filter((h: any) => h.status !== 'closed') ?? [];

      return Promise.resolve([
        new BrainclawTreeItem(`Plans (${plans.length})`, plans.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None, undefined, new vscode.ThemeIcon('tasklist')),
        new BrainclawTreeItem(`Active Claims (${claims.length})`, claims.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None, undefined, new vscode.ThemeIcon('lock')),
        new BrainclawTreeItem(`Open Handoffs (${handoffs.length})`, handoffs.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None, undefined, new vscode.ThemeIcon('person'))
      ]);
    }

    // Child nodes
    if (element.label.startsWith('Plans')) {
      const plans = (this._board.plans as any[])?.filter((p: any) => p.status !== 'done' && p.status !== 'dropped') ?? [];
      return Promise.resolve(plans.map(p => 
        new BrainclawTreeItem(
          p.text, 
          vscode.TreeItemCollapsibleState.None, 
          `${p.status} · ${p.priority}`, 
          new vscode.ThemeIcon(p.status === 'in_progress' ? 'play-circle' : 'circle-outline'),
          `[${p.id.slice(0, 8)}] ${p.text}`
        )
      ));
    }

    if (element.label.startsWith('Active Claims')) {
      const claims = this._board.active_claims ?? [];
      return Promise.resolve(claims.map((c: any) => 
        new BrainclawTreeItem(
          c.scope, 
          vscode.TreeItemCollapsibleState.None, 
          `by ${c.agent}`, 
          new vscode.ThemeIcon('shield'),
          `Claimed by: ${c.agent}\nDescription: ${c.description}`
        )
      ));
    }

    if (element.label.startsWith('Open Handoffs')) {
      const handoffs = (this._board.open_handoffs as any[])?.filter((h: any) => h.status !== 'closed') ?? [];
      return Promise.resolve(handoffs.map((h: any) => 
        new BrainclawTreeItem(
          h.text, 
          vscode.TreeItemCollapsibleState.None, 
          `from ${h.from} to ${h.to}`, 
          new vscode.ThemeIcon('arrow-swap'),
          `From: ${h.from}\nTo: ${h.to}\nMessage: ${h.text}`
        )
      ));
    }

    return Promise.resolve([]);
  }
}

export function resolveBrainclawCmd(cwd: string): string | undefined {
  const opts = { stdio: 'ignore' as const, timeout: 3000 };

  const local = path.join(cwd, 'node_modules', '.bin', 'brainclaw');
  try {
    cp.execSync(`"${local}" --version`, opts);
    return `"${local}"`;
  } catch { }

  // Fallback: dist/cli.js in the workspace (dev mode)
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