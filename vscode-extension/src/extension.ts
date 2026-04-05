import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { BrainclawBoardProvider, BrainclawTreeItem } from './board-tree';

class EmptyTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(el: vscode.TreeItem) { return el; }
  getChildren() { return [new vscode.TreeItem('No workspace open')]; }
}

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

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  console.log('[brainclaw] activate — cwd:', cwd ?? 'NONE');

  // Board Tree Provider — always register to avoid "no data provider" error
  const treeProvider = cwd ? new BrainclawBoardProvider(cwd) : undefined;
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('brainclaw.agentBoard', treeProvider ?? new EmptyTreeProvider())
  );
  if (treeProvider) {
    context.subscriptions.push({ dispose: () => treeProvider.dispose() });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.refreshBoard', () => {
      treeProvider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.showBoard', () => {
      vscode.commands.executeCommand('brainclaw.agentBoard.focus');
    })
  );

  // --- Action commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.acceptCandidate', (item: BrainclawTreeItem) => {
      if (item.itemId) treeProvider?.exec(`accept ${item.itemId}`);
    }),
    vscode.commands.registerCommand('brainclaw.rejectCandidate', (item: BrainclawTreeItem) => {
      if (item.itemId) treeProvider?.exec(`reject ${item.itemId}`);
    }),
    vscode.commands.registerCommand('brainclaw.releaseClaim', (item: BrainclawTreeItem) => {
      if (item.itemId) treeProvider?.exec(`claim release ${item.itemId}`);
    }),
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
    eventWatcher = fs.watch(brainclawDir, (eventType: string, filename: string | Buffer | null) => {
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


