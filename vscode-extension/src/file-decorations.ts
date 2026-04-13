import * as vscode from 'vscode';
import * as path from 'path';
import { resolveBrainclawCmd } from './board-tree';
import { McpClient } from './mcp-client';

interface ClaimInfo {
  scope: string;
  agent: string;
  description?: string;
}

export class BrainclawFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private _claims: ClaimInfo[] = [];
  private _cwd: string;
  private _refreshTimer?: ReturnType<typeof setTimeout>;
  private _mcpClient: McpClient | undefined;
  private _mcpResolved = false;

  constructor(cwd: string) {
    this._cwd = cwd;
    this._refreshClaims();
  }

  refresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this._refreshClaims(), 500);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this._claims.length === 0) return undefined;

    const relativePath = path.relative(this._cwd, uri.fsPath).replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('..')) return undefined;

    for (const claim of this._claims) {
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

  private async _getOrCreateClient(): Promise<McpClient | undefined> {
    if (this._mcpResolved) return this._mcpClient;
    this._mcpResolved = true;
    const bclaw = await resolveBrainclawCmd(this._cwd);
    if (!bclaw) return undefined;
    this._mcpClient = new McpClient(this._cwd, bclaw);
    return this._mcpClient;
  }

  private async _refreshClaims(): Promise<void> {
    try {
      const client = await this._getOrCreateClient();
      if (!client) {
        this._claims = [];
        this._onDidChangeFileDecorations.fire(undefined);
        return;
      }

      // Use MCP (stdio-streamed, no maxBuffer limit) instead of cp.exec.
      // Ask only for active claims with generous pagination to avoid O(n) truncation.
      const result = await client.callTool('bclaw_list_claims', { limit: 1000 }) as {
        structuredContent?: { claims?: Array<{ scope: string; agent: string; description?: string; status?: string }> };
      };
      const claims = result.structuredContent?.claims ?? [];
      this._claims = claims
        .filter(c => !c.status || c.status === 'active')
        .map(c => ({ scope: c.scope, agent: c.agent, description: c.description }));
    } catch {
      this._claims = [];
    }

    this._onDidChangeFileDecorations.fire(undefined);
  }

  dispose(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    if (this._mcpClient) this._mcpClient.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
