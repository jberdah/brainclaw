import * as vscode from 'vscode';
import * as path from 'path';

import { BrainclawBoardProvider, BrainclawTreeItem, type BrainclawStatusSummary } from './board-tree';
import { BrainclawFileDecorationProvider } from './file-decorations';
import { discoverBrainclawProjects } from './project-discovery';
import {
  BRAINCLAW_SCHEME,
  BrainclawContentProvider,
  buildEntityUri,
  type OpenEntityArgs,
  type SupportedEntity,
} from './content-provider';

class EmptyTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(el: vscode.TreeItem) { return el; }
  getChildren() { return [new vscode.TreeItem('No workspace open')]; }
}

// --- Activation ---

let statusBarItem: vscode.StatusBarItem;
let doctorOutput: vscode.OutputChannel;
let searchOutput: vscode.OutputChannel;
let memoryOutput: vscode.OutputChannel;
let statusBarSummary: BrainclawStatusSummary = emptyStatusSummary();
let previousActionCount: number | undefined;
let previousFailedRuns: number | undefined;
// pln#559 step 3 — the TreeView reference, retained so we can update its
// badge (the chip on the activity-bar icon) when the summary changes.
// `registerTreeDataProvider` does not expose the badge property; `createTreeView`
// does. The badge is the visible-without-opening-the-sidebar attention surface.
let boardTreeView: vscode.TreeView<BrainclawTreeItem> | undefined;

export function activate(context: vscode.ExtensionContext) {
  vscode.commands.executeCommand('setContext', 'brainclaw.active', true);
  statusBarSummary = emptyStatusSummary();
  previousActionCount = undefined;

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const cwd = workspaceFolders[0]?.uri.fsPath;
  const projects = discoverBrainclawProjects(workspaceFolders);
  console.log('[brainclaw] activate — cwd:', cwd ?? 'NONE', 'projects:', projects.map((project) => project.path).join(', ') || 'none');

  // File Decoration Provider — shows lock icon on claimed scopes (created first
  // so we can wire its refresh callback into the tree provider for
  // post-mutation sync, pln#393 stp_9010b323).
  const fileDecoProvider = cwd ? new BrainclawFileDecorationProvider(cwd, projects) : undefined;
  if (fileDecoProvider) {
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileDecoProvider));
    context.subscriptions.push({ dispose: () => fileDecoProvider.dispose() });
  }

  // Board Tree Provider — always register to avoid "no data provider" error
  const treeProvider = cwd
    ? new BrainclawBoardProvider(cwd, projects, () => fileDecoProvider?.refresh(), handleStatusSummary, context.workspaceState)
    : undefined;
  // pln#558 step 4 — share the BoardProvider's MCP client pool with the file
  // decoration provider. Previously each provider spawned its own
  // `brainclaw mcp` subprocess + ran 3 --version probes per project. Routing
  // through one owner halves both, and (just as important) collapses the two
  // separate MCP sessions per project — which the server treats as two
  // distinct clients, doubling cursor consumption and reconciliation passes.
  if (fileDecoProvider && treeProvider) {
    fileDecoProvider.setMcpClientResolver((projectPath) => treeProvider.getMcpClient(projectPath));
    // Kick the initial claim fetch now that the shared pool is wired.
    fileDecoProvider.refresh();
  } else if (fileDecoProvider) {
    // No board provider (cwd-less workspace?) — still need the initial fetch.
    fileDecoProvider.refresh();
  }
  doctorOutput = vscode.window.createOutputChannel('Brainclaw Doctor');
  searchOutput = vscode.window.createOutputChannel('Brainclaw Search');
  memoryOutput = vscode.window.createOutputChannel('Brainclaw Memory');
  // pln#559 step 3 — createTreeView (not registerTreeDataProvider) so we own
  // a TreeView ref carrying the `.badge` property. The badge is rendered on
  // the activity-bar icon without the user opening the sidebar.
  if (treeProvider) {
    boardTreeView = vscode.window.createTreeView('brainclaw.agentBoard', { treeDataProvider: treeProvider });
    context.subscriptions.push(boardTreeView);
  } else {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('brainclaw.agentBoard', new EmptyTreeProvider()),
    );
  }
  context.subscriptions.push(doctorOutput, searchOutput, memoryOutput);
  if (treeProvider) {
    context.subscriptions.push({ dispose: () => treeProvider.dispose() });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.refreshBoard', async () => {
      await treeProvider?.refresh();
      fileDecoProvider?.refresh();
    })
  );

  // Entity preview: virtual brainclaw: documents rendered as markdown in the editor
  const contentProvider = treeProvider
    ? new BrainclawContentProvider((projectPath) => treeProvider.getMcpClient(projectPath))
    : undefined;
  if (contentProvider) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(BRAINCLAW_SCHEME, contentProvider),
      { dispose: () => contentProvider.dispose() },
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.openEntity', async (args: OpenEntityArgs) => {
      if (!args || !args.entity || !args.id || !args.projectPath) return;
      const uri = buildEntityUri(args);
      await openEntityPreview(uri);
    }),
    vscode.commands.registerCommand('brainclaw.refreshEntityPreview', async (args: OpenEntityArgs) => {
      if (!contentProvider || !args) return;
      contentProvider.notifyChange(buildEntityUri(args));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.showBoard', () => {
      vscode.commands.executeCommand('brainclaw.agentBoard.focus');
    })
  );

  // --- Action commands ---
  // pln#393 stp_9010b323: every state-mutating action awaits the underlying
  // MCP call AND the post-write refresh so the UI reflects reality before the
  // handler returns. Previous void handlers let the VS Code command resolve
  // before the refresh hit, which surfaced as stale rows after approve/reject.
  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.acceptCandidate', async (item: BrainclawTreeItem) => {
      if (item.itemId) await treeProvider?.exec(`accept ${item.itemId}`, item.projectPath);
    }),
    vscode.commands.registerCommand('brainclaw.rejectCandidate', async (item: BrainclawTreeItem) => {
      if (item.itemId) await treeProvider?.exec(`reject ${item.itemId}`, item.projectPath);
    }),
    vscode.commands.registerCommand('brainclaw.releaseClaim', async (item: BrainclawTreeItem) => {
      if (item.itemId) await treeProvider?.releaseClaim(item.itemId, item.projectPath);
    }),
    vscode.commands.registerCommand('brainclaw.approveAction', async (item: BrainclawTreeItem) => {
      if (item.itemId) await treeProvider?.approveAction(item.itemId, item.projectPath);
    }),
    vscode.commands.registerCommand('brainclaw.rejectAction', async (item: BrainclawTreeItem) => {
      if (item.itemId) await treeProvider?.rejectAction(item.itemId, item.projectPath);
    }),
    vscode.commands.registerCommand('brainclaw.dispatchPlan', async (item: BrainclawTreeItem) => {
      if (item.itemId) await treeProvider?.dispatchPlan(item.itemId, item.projectPath);
    }),
    // pln#559 step 4 — triage shortcuts. The supervisor's incident loop is
    // see-anomaly → open-worktree → inspect; the tree only supported step 1.
    vscode.commands.registerCommand('brainclaw.openWorktree', async (item: BrainclawTreeItem) => {
      // Worker rows carry `worktreePath` attached during build. Fallback: ask
      // the provider to resolve it from the live entity (cheap, no MCP call —
      // the tree already has the assignment data cached).
      const worktreePath = (item as any).worktreePath ?? await treeProvider?.resolveWorktreePath(item);
      if (!worktreePath) {
        vscode.window.showWarningMessage('Brainclaw: no worktree path on this item.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('brainclaw.showCapturedLogs', async (item: BrainclawTreeItem) => {
      const logPaths = ((item as any).logPaths ?? []) as string[];
      if (logPaths.length === 0) {
        // pln#559 step 4 — fallback: synthesize the canonical log paths from
        // the worktree-or-project + assignment id, since dispatch_status may
        // not have populated logPaths on items that landed via summary mode.
        const fallback = await treeProvider?.resolveCapturedLogPaths(item);
        if (!fallback || fallback.length === 0) {
          vscode.window.showWarningMessage('Brainclaw: no captured logs known for this item.');
          return;
        }
        logPaths.push(...fallback);
      }
      // Open each log in a peek-style document (preserveFocus so the tree
      // keeps the keyboard). Reading the file is read-only; if it doesn't
      // exist VS Code surfaces its own friendly error.
      for (const p of logPaths) {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          vscode.window.showWarningMessage(`Brainclaw: cannot open log ${p}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );

  // --- Toolbar commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.quickCapture', async () => {
      const text = await vscode.window.showInputBox({
        prompt: 'Quick capture',
        placeHolder: 'Note, idea, or decision...',
      });
      if (text === undefined) return;
      const trimmed = text.trim();
      if (!trimmed) {
        vscode.window.showWarningMessage('Brainclaw: enter text to capture');
        return;
      }
      await treeProvider?.quickCapture(trimmed);
    }),
    vscode.commands.registerCommand('brainclaw.dispatch', async () => {
      await treeProvider?.dispatchWithPicker();
    }),
    vscode.commands.registerCommand('brainclaw.search', async () => {
      await treeProvider?.searchWithPicker(searchOutput);
    }),
    vscode.commands.registerCommand('brainclaw.doctor', async () => {
      await treeProvider?.runDoctor(doctorOutput);
    }),
  );

  // --- Explorer context menu commands ---
  // pln#393 stp_9010b323: these previously used fire-and-forget exec() calls
  // that swallowed errors and never waited for the post-write refresh.
  // They now go through awaited MCP tool calls with explicit error surface.
  context.subscriptions.push(
    vscode.commands.registerCommand('brainclaw.claimScope', async (uri: vscode.Uri) => {
      if (!cwd || !uri) return;
      const scope = path.relative(cwd, uri.fsPath).replace(/\\/g, '/');
      const description = await vscode.window.showInputBox({ prompt: 'Claim description', placeHolder: 'What are you working on?' });
      if (description === undefined) return;
      const trimmed = description.trim();
      if (!trimmed) {
        vscode.window.showWarningMessage('Brainclaw: enter a claim description');
        return;
      }
      await treeProvider?.claimScope(scope, trimmed);
    }),
    vscode.commands.registerCommand('brainclaw.addTrap', async (uri: vscode.Uri) => {
      if (!cwd || !uri) return;
      const scope = path.relative(cwd, uri.fsPath).replace(/\\/g, '/');
      const text = await vscode.window.showInputBox({ prompt: 'Trap description', placeHolder: 'What can go wrong here?' });
      if (text === undefined) return;
      const trimmed = text.trim();
      if (!trimmed) {
        vscode.window.showWarningMessage('Brainclaw: enter a trap description');
        return;
      }
      await treeProvider?.addTrap(trimmed, scope);
    }),
    vscode.commands.registerCommand('brainclaw.viewMemory', async (uri: vscode.Uri) => {
      if (!cwd || !uri) return;
      const scope = path.relative(cwd, uri.fsPath).replace(/\\/g, '/');
      await treeProvider?.viewMemoryForScope(scope, memoryOutput);
    }),
  );

  // Status bar item — server-computed board summary
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = 'brainclaw.showBoard';
  statusBarItem.tooltip = 'Brainclaw coordination summary';
  updateStatusBar(statusBarSummary);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  if (treeProvider) {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const clearRefreshTimer = () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
    };
    const scheduleRefresh = () => {
      clearRefreshTimer();
      // pln#560 slice2 — in observer mode the journal file-watch drives refresh;
      // the blind polling timer is exactly the "polling timer against the MCP
      // server for display" the observer protocol §1 forbids, so disable it.
      if (isObserverMode()) return;
      const intervalMs = getRefreshIntervalMs();
      if (intervalMs <= 0) return;
      refreshTimer = setTimeout(async () => {
        await treeProvider.refresh();
        scheduleRefresh();
      }, intervalMs);
    };

    scheduleRefresh();
    context.subscriptions.push(
      { dispose: clearRefreshTimer },
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('brainclaw.refreshIntervalMs')
          || event.affectsConfiguration('brainclaw.observerMode')) {
          scheduleRefresh();
        }
      }),
    );
  }
}

export function deactivate() {
}

// --- Status bar ---

function emptyStatusSummary(): BrainclawStatusSummary {
  return {
    plans: 0,
    claims: 0,
    assignments: 0,
    runs: 0,
    actions: 0,
    agents: 0,
    sessions: 0,
  };
}

function getRefreshIntervalMs(): number {
  const configured = vscode.workspace.getConfiguration('brainclaw').get<number>('refreshIntervalMs', 30_000);
  if (!Number.isFinite(configured)) return 30_000;
  if (configured <= 0) return 0;
  return Math.max(1_000, Math.floor(configured));
}

function isObserverMode(): boolean {
  return vscode.workspace.getConfiguration('brainclaw').get<boolean>('observerMode', false) === true;
}

function getNotificationMode(): 'urgent' | 'all' | 'none' {
  const configured = vscode.workspace.getConfiguration('brainclaw').get<string>('notifications', 'urgent');
  if (configured === 'all' || configured === 'none') return configured;
  return 'urgent';
}

function handleStatusSummary(summary: BrainclawStatusSummary): void {
  const previous = previousActionCount;
  const previousFailed = previousFailedRuns;
  statusBarSummary = summary;
  updateStatusBar(summary);

  // pln#559 step 3 — update the activity-bar badge from the same composite
  // the status bar uses. Badge value = action count; tooltip = the same
  // human-readable summary. Setting `value: 0` clears the badge.
  if (boardTreeView) {
    if (summary.actions > 0) {
      boardTreeView.badge = {
        value: summary.actions,
        tooltip: `${summary.actions} item(s) need attention`,
      };
    } else {
      boardTreeView.badge = undefined;
    }
  }

  const mode = getNotificationMode();

  // pln#559 step 3 — fix the no-op urgent/all distinction (D7). The previous
  // handler treated urgent and all identically (both gated only by "actions
  // increased"). "All" must additionally surface a toast when the registry
  // observes a worker failure (failed runs increased) so the operator hears
  // about the 2026-06-10-style silent_death without watching the tree.
  if (mode !== 'none' && previous !== undefined && summary.actions > previous) {
    void vscode.window.showInformationMessage(
      `Brainclaw: ${summary.actions - previous} new action required`,
      'Show Board',
    ).then((choice) => {
      if (choice === 'Show Board') {
        void vscode.commands.executeCommand('brainclaw.showBoard');
      }
    });
  }
  if (mode === 'all'
    && previousFailed !== undefined
    && summary.failedRuns !== undefined
    && summary.failedRuns > previousFailed
  ) {
    void vscode.window.showWarningMessage(
      `Brainclaw: ${summary.failedRuns - previousFailed} assignment(s) failed`,
      'Show Board',
    ).then((choice) => {
      if (choice === 'Show Board') {
        void vscode.commands.executeCommand('brainclaw.showBoard');
      }
    });
  }
  previousActionCount = summary.actions;
  previousFailedRuns = summary.failedRuns;
}

// --- Entity preview column tracking ---
// Two VS Code quirks shape this:
//   1. `markdown.showPreviewToSide` opens ViewColumn.Beside the active editor.
//      Because the new preview becomes active, chained calls walk rightward
//      (col 2 → 3 → 4…) rather than stacking tabs in one group.
//   2. An unlocked markdown preview is *replaced* by the next preview in the
//      same column instead of opening a new tab.
// Fix: open each preview with `locked: true`. A locked preview refuses to be
// reused, so the next open creates a fresh tab. We also track the column of
// the first preview and target that column explicitly for subsequent opens so
// everything stacks in one group. `markdown.showPreview` accepts settings as
// its 3rd arg: {sideBySide, locked}.

let brainclawPreviewColumn: vscode.ViewColumn | undefined;

async function openEntityPreview(uri: vscode.Uri): Promise<void> {
  if (brainclawPreviewColumn !== undefined) {
    const stillExists = vscode.window.tabGroups.all.some(
      (group) => group.viewColumn === brainclawPreviewColumn,
    );
    if (!stillExists) brainclawPreviewColumn = undefined;
  }

  if (brainclawPreviewColumn === undefined) {
    await vscode.commands.executeCommand(
      'markdown.showPreview',
      uri,
      undefined,
      { sideBySide: true, locked: true },
    );
    brainclawPreviewColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    return;
  }

  const focusCommand = focusEditorGroupCommand(brainclawPreviewColumn);
  if (focusCommand) await vscode.commands.executeCommand(focusCommand);
  await vscode.commands.executeCommand(
    'markdown.showPreview',
    uri,
    undefined,
    { sideBySide: false, locked: true },
  );
}

function focusEditorGroupCommand(column: vscode.ViewColumn): string | undefined {
  switch (column) {
    case vscode.ViewColumn.One: return 'workbench.action.focusFirstEditorGroup';
    case vscode.ViewColumn.Two: return 'workbench.action.focusSecondEditorGroup';
    case vscode.ViewColumn.Three: return 'workbench.action.focusThirdEditorGroup';
    case vscode.ViewColumn.Four: return 'workbench.action.focusFourthEditorGroup';
    case vscode.ViewColumn.Five: return 'workbench.action.focusFifthEditorGroup';
    case vscode.ViewColumn.Six: return 'workbench.action.focusSixthEditorGroup';
    case vscode.ViewColumn.Seven: return 'workbench.action.focusSeventhEditorGroup';
    case vscode.ViewColumn.Eight: return 'workbench.action.focusEighthEditorGroup';
    default: return undefined;
  }
}

function updateStatusBar(summary: BrainclawStatusSummary): void {
  const inProgress = summary.claims + summary.assignments + summary.runs;
  statusBarItem.text = `$(brain) Brainclaw: ${summary.actions} urgent · ${inProgress} in progress · ${summary.plans} plans`;
  statusBarItem.tooltip = [
    'Brainclaw coordination summary',
    `Urgent actions: ${summary.actions}`,
    `Claims: ${summary.claims}`,
    `Assignments: ${summary.assignments}`,
    `Runs: ${summary.runs}`,
    `Plans: ${summary.plans}`,
    `Agents: ${summary.agents}`,
    `Open sessions: ${summary.sessions}`,
  ].join('\n');
  statusBarItem.backgroundColor = summary.actions > 0
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
}


