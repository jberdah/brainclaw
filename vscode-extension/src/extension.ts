import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { BoardProject, BrainclawBoardProvider, BrainclawTreeItem } from './board-tree';

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
const PROJECT_SCAN_SKIP_DIRS = new Set([
  '.brainclaw',
  '.git',
  'node_modules',
  'dist',
  'dist-test',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
]);

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

function discoverBrainclawProjects(workspaceFolders: readonly vscode.WorkspaceFolder[]): BoardProject[] {
  const discovered = new Map<string, BoardProject>();
  for (const folder of workspaceFolders) {
    scanWorkspaceFolder(folder.uri.fsPath, folder.uri.fsPath, 0, discovered);
  }

  return [...discovered.values()].sort((left, right) => {
    if (left.isWorkspaceRoot !== right.isWorkspaceRoot) {
      return left.isWorkspaceRoot ? -1 : 1;
    }
    return left.relativePath.localeCompare(right.relativePath) || left.path.localeCompare(right.path);
  });
}

function scanWorkspaceFolder(rootPath: string, currentPath: string, depth: number, discovered: Map<string, BoardProject>): void {
  // Depth 3 supports monorepos (e.g. packages/foo/.brainclaw/) without scanning too deep
  if (depth > 3) {
    return;
  }

  const normalizedPath = path.resolve(currentPath);
  if (fs.existsSync(path.join(normalizedPath, '.brainclaw'))) {
    const relativePath = path.relative(rootPath, normalizedPath) || '.';
    discovered.set(normalizedPath, {
      path: normalizedPath,
      name: path.basename(normalizedPath),
      relativePath,
      isWorkspaceRoot: relativePath === '.',
    });
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(normalizedPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (PROJECT_SCAN_SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.brainclaw') continue;
    scanWorkspaceFolder(rootPath, path.join(normalizedPath, entry.name), depth + 1, discovered);
  }
}

// --- Activation ---

let statusBarItem: vscode.StatusBarItem;
let eventWatchers: fs.FSWatcher[] = [];
let unseenCount = 0;

export function activate(context: vscode.ExtensionContext) {
  vscode.commands.executeCommand('setContext', 'brainclaw.active', true);

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const cwd = workspaceFolders[0]?.uri.fsPath;
  const projects = discoverBrainclawProjects(workspaceFolders);
  console.log('[brainclaw] activate — cwd:', cwd ?? 'NONE', 'projects:', projects.map((project) => project.path).join(', ') || 'none');

  // Board Tree Provider — always register to avoid "no data provider" error
  const treeProvider = cwd ? new BrainclawBoardProvider(cwd, projects) : undefined;
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
      if (item.itemId) treeProvider?.exec(`accept ${item.itemId}`, item.projectPath);
    }),
    vscode.commands.registerCommand('brainclaw.rejectCandidate', (item: BrainclawTreeItem) => {
      if (item.itemId) treeProvider?.exec(`reject ${item.itemId}`, item.projectPath);
    }),
    vscode.commands.registerCommand('brainclaw.releaseClaim', (item: BrainclawTreeItem) => {
      if (item.itemId) treeProvider?.exec(`claim release ${item.itemId}`, item.projectPath);
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
      for (const project of projects) {
        advanceCursor(project.path);
      }
      unseenCount = 0;
      updateStatusBar(0);
    })
  );

  // Start watching events.jsonl
  if (projects.length > 0) {
    startEventBusWatchers(projects.map((project) => project.path));
  }
}

export function deactivate() {
  for (const watcher of eventWatchers) {
    watcher.close();
  }
  eventWatchers = [];
}

// --- Event bus watcher ---

function startEventBusWatchers(cwds: string[]): void {
  for (const watcher of eventWatchers) {
    watcher.close();
  }
  eventWatchers = [];

  const uniqueCwds = [...new Set(cwds.map((cwd) => path.resolve(cwd)))];
  for (const cwd of uniqueCwds) {
    const brainclawDir = path.join(cwd, '.brainclaw');
    if (!fs.existsSync(brainclawDir)) {
      continue;
    }

    advanceCursor(cwd);

    try {
      const watcher = fs.watch(brainclawDir, (_eventType: string, filename: string | Buffer | null) => {
        if (filename === EVENTS_FILE || filename === EVENTS_FILE.replace(/\//g, '\\')) {
          processNewEvents(cwd);
        }
      });
      eventWatchers.push(watcher);
    } catch {
      // Ignore watcher failures for individual projects.
    }
  }
}

function processNewEvents(cwd: string): void {
  const events = readUnseenEvents(cwd);
  if (events.length === 0) return;

  unseenCount += events.length;
  updateStatusBar(unseenCount);

  // Status bar badge is enough — no toast popups (too noisy with active agents).
  // The user can click the status bar to see the board.
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


