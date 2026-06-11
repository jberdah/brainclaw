import * as vscode from 'vscode';
import * as path from 'path';
import { resolveBrainclawCmd, type BoardProject } from './board-tree';
import { McpClient } from './mcp-client';

interface ClaimInfo {
  scope: string;
  agent: string;
  description?: string;
}

export type McpClientResolver = (projectPath: string) => Promise<McpClient | null>;

export class BrainclawFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private _projectRoots: string[];
  private _claimsByProject = new Map<string, ClaimInfo[]>();
  private _refreshTimer?: ReturnType<typeof setTimeout>;
  // Local fallback cache — used ONLY when no shared resolver is set. With the
  // resolver in place (BoardProvider as MCP-client owner, pln#558 step 4)
  // these maps stay empty; one process per project instead of two.
  private _mcpClients = new Map<string, McpClient>();
  private _mcpResolved = new Map<string, boolean>();
  private _externalResolver?: McpClientResolver;

  constructor(cwd: string, projects: readonly Pick<BoardProject, 'path'>[] = []) {
    const roots = projects.length > 0 ? projects.map((project) => project.path) : [cwd];
    this._projectRoots = [...new Set(roots.map((root) => path.resolve(root)))]
      .sort((left, right) => right.length - left.length);
    // Defer the first refresh so the caller can wire setMcpClientResolver()
    // before we touch the MCP layer (otherwise we'd spawn a private subprocess
    // and the shared-pool optimisation wouldn't apply to the initial fetch).
  }

  /**
   * Share the MCP-client pool with the board tree provider (pln#558 step 4).
   * Once set, this provider stops spawning its own `brainclaw mcp` subprocess
   * and reuses the one BoardProvider already manages — halving the process
   * count, the --version probes, and the open MCP sessions per project.
   */
  setMcpClientResolver(resolver: McpClientResolver): void {
    this._externalResolver = resolver;
  }

  refresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this._refreshClaims(), 500);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const projectRoot = this._findProjectRoot(uri.fsPath);
    if (!projectRoot) return undefined;

    const claims = this._claimsByProject.get(projectRoot) ?? [];
    if (claims.length === 0) return undefined;

    const relativePath = path.relative(projectRoot, uri.fsPath).replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('..')) return undefined;

    for (const claim of claims) {
      const scopes = claim.scope.split(',').map(s => s.trim());
      for (const scope of scopes) {
        if (relativePath.startsWith(scope) || scope.startsWith(relativePath + '/') || scope === relativePath) {
          return {
            badge: '\u{1F512}',
            tooltip: `Claimed by ${claim.agent}${claim.description ? ' — ' + claim.description : ''}`,
            color: new vscode.ThemeColor('editorWarning.foreground'),
          };
        }
      }
    }

    return undefined;
  }

  private _findProjectRoot(fsPath: string): string | undefined {
    const normalizedPath = path.resolve(fsPath);
    return this._projectRoots.find((root) => normalizedPath === root || normalizedPath.startsWith(root + path.sep));
  }

  private async _getOrCreateClient(projectRoot: string): Promise<McpClient | undefined> {
    // Prefer the shared resolver if BoardProvider has been wired in — single
    // MCP process per project, single --version probe, single cursor.
    if (this._externalResolver) {
      const shared = await this._externalResolver(projectRoot);
      return shared ?? undefined;
    }
    if (this._mcpResolved.get(projectRoot)) return this._mcpClients.get(projectRoot);
    this._mcpResolved.set(projectRoot, true);
    const bclaw = await resolveBrainclawCmd(projectRoot);
    if (!bclaw) return undefined;
    const client = new McpClient(projectRoot, bclaw);
    this._mcpClients.set(projectRoot, client);
    return client;
  }

  private async _refreshClaims(): Promise<void> {
    await Promise.all(this._projectRoots.map((projectRoot) => this._refreshProjectClaims(projectRoot)));
    this._onDidChangeFileDecorations.fire(undefined);
  }

  private async _refreshProjectClaims(projectRoot: string): Promise<void> {
    try {
      const client = await this._getOrCreateClient(projectRoot);
      if (!client) {
        this._claimsByProject.set(projectRoot, []);
        return;
      }

      // Use MCP (stdio-streamed, no maxBuffer limit) instead of cp.exec.
      // Ask only for active claims with generous pagination to avoid O(n) truncation.
      const result = await client.callTool('bclaw_find', {
        entity: 'claim',
        filter: { limit: 1000 },
      }) as { items?: Array<{ scope: string; agent: string; description?: string; status?: string }> };
      const claims = result.items ?? [];
      this._claimsByProject.set(projectRoot, claims
        .filter(c => !c.status || c.status === 'active')
        .map(c => ({ scope: c.scope, agent: c.agent, description: c.description })));
    } catch {
      this._claimsByProject.set(projectRoot, []);
    }
  }

  dispose(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    for (const client of this._mcpClients.values()) {
      client.dispose();
    }
    this._mcpClients.clear();
    this._onDidChangeFileDecorations.dispose();
  }
}
