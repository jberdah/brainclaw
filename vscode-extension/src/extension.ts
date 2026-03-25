import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// --- Event bus types (mirror of core/event-log.ts) ---

interface MemoryEvent {
  ts: string;
  agent: string;
  agent_id?: string;
  action: string;
  item_type: string;
  item_id?: string;
  summary?: string;
}

interface AgentCursor {
  offset: number;
  last_read: string;
}

// --- Constants ---

const EVENTS_FILE = 'events.jsonl';
const CURSORS_DIR = '.cursors';
const VSCODE_AGENT = 'vscode-extension';

// Human-readable labels for event actions
const ACTION_LABELS: Record<string, string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  accept: 'accepted',
  reject: 'rejected',
  claim: 'claimed',
  release_claim: 'released claim on',
  session_start: 'started session',
  session_end: 'ended session',
};

const ITEM_LABELS: Record<string, string> = {
  constraint: 'constraint',
  decision: 'decision',
  trap: 'trap',
  handoff: 'handoff',
  plan: 'plan',
  claim: 'scope',
  candidate: 'candidate',
  runtime_note: 'note',
  instruction: 'instruction',
  session: 'session',
  state: 'state',
};

// --- Activation ---

let statusBarItem: vscode.StatusBarItem;
let eventWatcher: fs.FSWatcher | undefined;
let unseenCount = 0;

export function activate(context: vscode.ExtensionContext) {
  vscode.commands.executeCommand('setContext', 'brainclaw.active', true);

  // Board provider (existing)
  const provider = new BrainclawBoardProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('brainclaw.agentBoard', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.showBoard', () => {
      vscode.commands.executeCommand('brainclaw.agentBoard.focus');
    })
  );

  // Status bar item — unseen event count
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = 'brainclaw.clearNotifications';
  statusBarItem.tooltip = 'Brainclaw: unseen agent events (click to clear)';
  updateStatusBar(0);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Clear notifications command
  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.clearNotifications', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (cwd) {
        advanceCursor(cwd);
      }
      unseenCount = 0;
      updateStatusBar(0);
    })
  );

  // Start watching events.jsonl
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (cwd) {
    startEventBusWatcher(cwd);
  }
}

export function deactivate() {
  eventWatcher?.close();
  eventWatcher = undefined;
}

// --- Event bus watcher ---

function startEventBusWatcher(cwd: string): void {
  const brainclawDir = path.join(cwd, '.brainclaw');
  const eventsPath = path.join(brainclawDir, EVENTS_FILE);

  // Initial read to set baseline cursor (don't notify for pre-existing events)
  advanceCursor(cwd);

  // Watch for changes to events.jsonl
  // We watch the .brainclaw directory and filter for events.jsonl changes,
  // because the file may be recreated on rotation.
  try {
    eventWatcher = fs.watch(brainclawDir, (eventType, filename) => {
      if (filename === EVENTS_FILE || filename === EVENTS_FILE.replace(/\//g, '\\')) {
        processNewEvents(cwd);
      }
    });
  } catch {
    // .brainclaw dir may not exist yet — fall back to polling
    const poll = setInterval(() => {
      if (fs.existsSync(brainclawDir)) {
        clearInterval(poll);
        startEventBusWatcher(cwd);
      }
    }, 5000);
  }
}

function processNewEvents(cwd: string): void {
  const events = readUnseenEvents(cwd);
  if (events.length === 0) return;

  unseenCount += events.length;
  updateStatusBar(unseenCount);

  // Group events by agent for a compact notification
  const byAgent = new Map<string, string[]>();
  for (const evt of events) {
    const actionLabel = ACTION_LABELS[evt.action] ?? evt.action;
    const itemLabel = ITEM_LABELS[evt.item_type] ?? evt.item_type;
    const desc = evt.action === 'session_start' || evt.action === 'session_end'
      ? actionLabel
      : `${actionLabel} ${itemLabel}${evt.item_id ? ` [${evt.item_id.slice(0, 8)}]` : ''}`;
    const list = byAgent.get(evt.agent) ?? [];
    list.push(desc);
    byAgent.set(evt.agent, list);
  }

  // Show one notification per agent
  for (const [agent, actions] of byAgent) {
    const unique = [...new Set(actions)];
    const summary = unique.length <= 3
      ? unique.join(', ')
      : `${unique.slice(0, 2).join(', ')} +${unique.length - 2} more`;
    vscode.window.showInformationMessage(
      `Brainclaw: ${agent} — ${summary}`,
      'Show Board', 'Dismiss'
    ).then(choice => {
      if (choice === 'Show Board') {
        vscode.commands.executeCommand('brainclaw.agentBoard.focus');
      }
    });
  }
}

// --- Cursor-based event reading (mirrors core/event-log.ts logic) ---

function eventsPath(cwd: string): string {
  return path.join(cwd, '.brainclaw', EVENTS_FILE);
}

function cursorDir(cwd: string): string {
  return path.join(cwd, '.brainclaw', CURSORS_DIR);
}

function cursorPath(cwd: string): string {
  return path.join(cursorDir(cwd), `${VSCODE_AGENT}.json`);
}

function loadCursor(cwd: string): AgentCursor {
  const fp = cursorPath(cwd);
  if (!fs.existsSync(fp)) return { offset: 0, last_read: '' };
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as AgentCursor;
  } catch {
    return { offset: 0, last_read: '' };
  }
}

function saveCursor(cwd: string, cursor: AgentCursor): void {
  const dir = cursorDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(cursorPath(cwd), JSON.stringify(cursor), 'utf-8');
}

function readUnseenEvents(cwd: string): MemoryEvent[] {
  const logPath = eventsPath(cwd);
  if (!fs.existsSync(logPath)) return [];

  const cursor = loadCursor(cwd);
  let size: number;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return [];
  }

  if (size <= cursor.offset) return [];

  // Read from offset
  const fd = fs.openSync(logPath, 'r');
  const buffer = Buffer.alloc(size - cursor.offset);
  fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
  fs.closeSync(fd);

  const newContent = buffer.toString('utf-8');
  const lines = newContent.split('\n').filter(Boolean);
  const events: MemoryEvent[] = [];
  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as MemoryEvent;
      // Exclude events from self and session noise
      if (evt.agent !== VSCODE_AGENT) {
        events.push(evt);
      }
    } catch {
      // skip malformed
    }
  }

  // Update cursor
  saveCursor(cwd, { offset: size, last_read: new Date().toISOString() });

  return events;
}

/** Advance cursor to current EOF without reading events (used for baseline & clear). */
function advanceCursor(cwd: string): void {
  const logPath = eventsPath(cwd);
  if (!fs.existsSync(logPath)) return;
  try {
    const size = fs.statSync(logPath).size;
    saveCursor(cwd, { offset: size, last_read: new Date().toISOString() });
  } catch {
    // ignore
  }
}

// --- Status bar ---

function updateStatusBar(count: number): void {
  if (count === 0) {
    statusBarItem.text = '$(brain) Brainclaw';
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(brain) Brainclaw (${count})`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

// --- Board provider (existing, unchanged) ---

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
          if (['added', 'changed', 'removed', 'plan_added', 'constraint_added',
               'claim_created', 'claim_released', 'handoff_added', 'decision_added'
          ].includes(event.event)) {
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
  const handoffs = (board.open_handoffs as Array<{id:string;from:string;to:string;text:string;status?:string}> ?? [])
    .filter(h => h.status !== 'closed');

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
    <p style="margin-top:16px;opacity:.35;font-size:10px">Live via brainclaw watch + event bus</p>
  </body></html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
