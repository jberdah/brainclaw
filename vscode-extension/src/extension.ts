import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
  vscode.commands.executeCommand('setContext', 'brainclaw.active', true);

  const provider = new BrainclawBoardProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('brainclaw.agentBoard', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.showBoard', () => {
      vscode.commands.executeCommand('brainclaw.agentBoard.focus');
    })
  );
}

export function deactivate() {}

class BrainclawBoardProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _watcher?: cp.ChildProcess;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getLoadingHtml();

    this._startWatch();

    webviewView.onDidDispose(() => {
      this._watcher?.kill();
      this._watcher = undefined;
    });
  }

  private _startWatch() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    const bclaw = resolveBrainclawCmd(cwd);

    // Initial board load
    cp.exec(`${bclaw} agent-board --json`, { cwd }, (err, stdout) => {
      if (!err && stdout) this._updateBoard(stdout);
    });

    // Live updates via brainclaw watch NDJSON
    this._watcher = cp.spawn(bclaw, ['watch'], { cwd, shell: true });
    this._watcher.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (['plan_added', 'constraint_added', 'claim_created', 'claim_released',
               'handoff_added', 'decision_added'].includes(event.event)) {
            // Refresh board on relevant events
            cp.exec(`${bclaw} agent-board --json`, { cwd }, (err, stdout) => {
              if (!err && stdout) this._updateBoard(stdout);
            });
          }
        } catch { /* skip malformed lines */ }
      }
    });
  }

  private _updateBoard(json: string) {
    try {
      const board = JSON.parse(json);
      this._view?.webview.postMessage({ type: 'update', board });
      this._view!.webview.html = getBoardHtml(board);
    } catch { /* skip parse errors */ }
  }
}

function resolveBrainclawCmd(cwd: string): string {
  // Prefer local install, fall back to global
  const local = path.join(cwd, 'node_modules', '.bin', 'brainclaw');
  try {
    cp.execSync(`"${local}" --version`, { stdio: 'ignore' });
    return `"${local}"`;
  } catch {
    return 'brainclaw';
  }
}

function getLoadingHtml(): string {
  return `<!DOCTYPE html><html><body style="padding:12px;font-family:sans-serif;color:var(--vscode-foreground)">
    <p>Loading brainclaw board…</p></body></html>`;
}

function getBoardHtml(board: Record<string, unknown>): string {
  const plans = (board.plans as Array<{id:string;text:string;status:string;priority:string}> ?? [])
    .filter(p => p.status !== 'done' && p.status !== 'dropped');
  const claims = board.active_claims as Array<{id:string;agent:string;scope:string;description:string}> ?? [];
  const handoffs = (board.open_handoffs as Array<{id:string;from:string;to:string;text:string}> ?? [])
    .filter((h: {status?: string}) => h.status !== 'closed');

  const section = (title: string, rows: string[]) => rows.length === 0 ? '' : `
    <h3 style="margin:12px 0 4px;font-size:11px;text-transform:uppercase;opacity:.6">${title}</h3>
    ${rows.join('')}`;

  const planRows = plans.map(p => `
    <div style="margin:4px 0;padding:6px 8px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;font-size:12px">
      <span style="opacity:.5">[${p.id.slice(0,8)}]</span> ${escHtml(p.text)}
      <span style="float:right;opacity:.5">${p.status} · ${p.priority}</span>
    </div>`);

  const claimRows = claims.map(c => `
    <div style="margin:4px 0;padding:6px 8px;background:var(--vscode-inputValidation-warningBackground,#3a3a00);border-radius:4px;font-size:12px">
      <b>${escHtml(c.agent)}</b> → ${escHtml(c.scope)}
    </div>`);

  const handoffRows = handoffs.map(h => `
    <div style="margin:4px 0;padding:6px 8px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;font-size:12px">
      ${escHtml(h.from)} → ${escHtml(h.to)}: ${escHtml(h.text)}
    </div>`);

  return `<!DOCTYPE html><html><body style="padding:12px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);font-size:13px">
    <h2 style="margin:0 0 8px;font-size:13px">🧠 Brainclaw Board</h2>
    ${section('Plans', planRows)}
    ${section('Active Claims', claimRows)}
    ${section('Open Handoffs', handoffRows)}
    ${plans.length + claims.length + handoffs.length === 0 ? '<p style="opacity:.5">No active coordination state.</p>' : ''}
    <p style="margin-top:16px;opacity:.35;font-size:10px">Live via brainclaw watch</p>
  </body></html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
