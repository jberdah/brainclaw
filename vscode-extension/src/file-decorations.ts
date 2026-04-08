import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { resolveBrainclawCmd } from './board-tree';

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

  private async _refreshClaims(): Promise<void> {
    try {
      const bclaw = await resolveBrainclawCmd(this._cwd);
      if (!bclaw) {
        this._claims = [];
        return;
      }

      const output = await new Promise<string>((resolve, reject) => {
        cp.exec(`${bclaw} claim list --json`, { cwd: this._cwd, timeout: 10_000 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });

      const claims = JSON.parse(output) as Array<{ scope: string; agent: string; description?: string; status?: string }>;
      this._claims = claims
        .filter(c => c.status === 'active')
        .map(c => ({ scope: c.scope, agent: c.agent, description: c.description }));
    } catch {
      this._claims = [];
    }

    this._onDidChangeFileDecorations.fire(undefined);
  }

  dispose(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._onDidChangeFileDecorations.dispose();
  }
}
