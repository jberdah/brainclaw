import * as vscode from 'vscode';
import { McpClient } from './mcp-client';
import { timeAgo } from './tree-helpers';

export const BRAINCLAW_SCHEME = 'brainclaw';

export type SupportedEntity = 'plan' | 'claim' | 'trap' | 'handoff' | 'agent';

const ENTITY_LABEL: Record<SupportedEntity, string> = {
  plan: 'Plan',
  claim: 'Claim',
  trap: 'Trap',
  handoff: 'Handoff',
  agent: 'Agent',
};

export interface OpenEntityArgs {
  entity: SupportedEntity;
  id: string;
  projectPath: string;
}

export function buildEntityUri(args: OpenEntityArgs): vscode.Uri {
  const safeId = args.id.replace(/[^\w.-]/g, '_');
  const query = `project=${encodeURIComponent(args.projectPath)}`;
  return vscode.Uri.parse(`${BRAINCLAW_SCHEME}:/${args.entity}/${safeId}.md?${query}`, true);
}

export function parseEntityUri(uri: vscode.Uri): OpenEntityArgs | null {
  if (uri.scheme !== BRAINCLAW_SCHEME) return null;
  const parts = uri.path.replace(/^\/+/, '').split('/');
  if (parts.length !== 2) return null;
  const entity = parts[0] as SupportedEntity;
  if (!ENTITY_LABEL[entity]) return null;
  const id = parts[1].replace(/\.md$/, '');
  const params = new URLSearchParams(uri.query);
  const projectPath = params.get('project') ?? '';
  if (!projectPath) return null;
  return { entity, id, projectPath };
}

export type McpClientResolver = (projectPath: string) => Promise<McpClient | null>;

export class BrainclawContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly _resolveClient: McpClientResolver) {}

  notifyChange(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken): Promise<string> {
    const parsed = parseEntityUri(uri);
    if (!parsed) return renderError('Unsupported brainclaw URI', uri.toString());

    const client = await this._resolveClient(parsed.projectPath);
    if (!client) return renderError('No brainclaw MCP client available for project', parsed.projectPath);

    let result: Record<string, unknown>;
    try {
      result = await client.callTool('bclaw_get', { entity: parsed.entity, id: parsed.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return renderError(`Failed to load ${parsed.entity} ${parsed.id}`, message);
    }

    const item = (result.item ?? result) as Record<string, any>;
    if (!item || typeof item !== 'object') {
      return renderError(`${ENTITY_LABEL[parsed.entity]} ${parsed.id} not found`, '');
    }

    switch (parsed.entity) {
      case 'plan': return renderPlan(item, parsed);
      case 'claim': return renderClaim(item, parsed);
      case 'trap': return renderTrap(item, parsed);
      case 'handoff': return renderHandoff(item, parsed);
      case 'agent': return renderAgent(item, parsed);
      default: return renderError('Unknown entity type', parsed.entity);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

// --- Renderers ---

function renderPlan(plan: Record<string, any>, args: OpenEntityArgs): string {
  const lines: string[] = [];
  const label = plan.short_label ? `${plan.short_label}` : plan.id;
  lines.push(`# Plan · ${label}`);
  lines.push('');
  if (plan.text) {
    lines.push(`> ${plan.text.split('\n').join('\n> ')}`);
    lines.push('');
  }

  lines.push('## Status');
  lines.push(mdTable([
    ['Status', plan.status ?? 'unknown'],
    ['Priority', plan.priority ?? 'medium'],
    ['Type', plan.type ?? '—'],
    ['Assignee', plan.assignee ?? '—'],
    ['Author', plan.author ?? '—'],
    ['Tags', formatList(plan.tags)],
    ['Depends on', formatList(plan.depends_on)],
  ]));
  lines.push('');

  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length > 0) {
    lines.push(`## Steps (${steps.filter((s: any) => s.status === 'done').length}/${steps.length})`);
    for (const step of steps) {
      const checkbox = step.status === 'done' ? '[x]' : step.status === 'in_progress' ? '[~]' : '[ ]';
      const stepLabel = step.short_label ?? step.id ?? '';
      const stepText = step.text ?? '';
      lines.push(`- ${checkbox} **${stepLabel}** — ${stepText}`);
      if (step.assignee) lines.push(`  - Assignee: \`${step.assignee}\``);
      if (step.status && step.status !== 'todo' && step.status !== 'done') {
        lines.push(`  - Status: \`${step.status}\``);
      }
    }
    lines.push('');
  }

  lines.push('## Timeline');
  lines.push(mdTable([
    ['Created', formatTime(plan.created_at)],
    ['Updated', formatTime(plan.updated_at)],
  ]));
  lines.push('');

  lines.push('## Actions');
  lines.push(renderCommandLink('Dispatch plan', 'brainclaw.dispatchPlan', buildFakeItem(args.projectPath, plan.id)));
  lines.push('');

  lines.push('---');
  lines.push(`_id:_ \`${plan.id}\``);
  lines.push(renderRefreshLink(args));

  return lines.join('\n');
}

function renderClaim(claim: Record<string, any>, args: OpenEntityArgs): string {
  const lines: string[] = [];
  lines.push(`# Claim · ${claim.short_label ?? claim.id}`);
  lines.push('');
  if (claim.description) {
    lines.push(`> ${claim.description.split('\n').join('\n> ')}`);
    lines.push('');
  }

  lines.push('## Details');
  lines.push(mdTable([
    ['Scope', claim.scope ?? '—'],
    ['Agent', claim.agent ?? '—'],
    ['Status', claim.status ?? 'active'],
    ['Handoff mode', claim.handoff_mode ?? '—'],
    ['Plan', claim.plan_id ?? '—'],
    ['Worktree', claim.worktree_path ?? '—'],
    ['Branch', claim.worktree_branch ?? '—'],
  ]));
  lines.push('');

  lines.push('## Timeline');
  lines.push(mdTable([
    ['Created', formatTime(claim.created_at)],
    ['Updated', formatTime(claim.updated_at)],
    ['Released', formatTime(claim.released_at) || '—'],
  ]));
  lines.push('');

  lines.push('## Actions');
  lines.push(renderCommandLink('Release claim', 'brainclaw.releaseClaim', buildFakeItem(args.projectPath, claim.id)));
  lines.push('');

  lines.push('---');
  lines.push(`_id:_ \`${claim.id}\``);
  lines.push(renderRefreshLink(args));

  return lines.join('\n');
}

function renderTrap(trap: Record<string, any>, args: OpenEntityArgs): string {
  const lines: string[] = [];
  lines.push(`# Trap · ${trap.short_label ?? trap.id}`);
  lines.push('');
  if (trap.text) {
    lines.push(`> ${trap.text.split('\n').join('\n> ')}`);
    lines.push('');
  }

  lines.push('## Details');
  lines.push(mdTable([
    ['Severity', trap.severity ?? '—'],
    ['Scope', trap.scope ?? '—'],
    ['Status', trap.status ?? 'active'],
    ['Author', trap.author ?? '—'],
    ['Tags', formatList(trap.tags)],
    ['Provenance', trap.provenance?.kind ?? '—'],
  ]));
  lines.push('');

  if (trap.mitigation) {
    lines.push('## Mitigation');
    lines.push(trap.mitigation);
    lines.push('');
  }

  lines.push('## Timeline');
  lines.push(mdTable([
    ['Created', formatTime(trap.created_at)],
    ['Updated', formatTime(trap.updated_at)],
  ]));
  lines.push('');

  lines.push('---');
  lines.push(`_id:_ \`${trap.id}\``);
  lines.push(renderRefreshLink(args));

  return lines.join('\n');
}

function renderHandoff(handoff: Record<string, any>, args: OpenEntityArgs): string {
  const lines: string[] = [];
  lines.push(`# Handoff · ${handoff.short_label ?? handoff.id}`);
  lines.push('');
  if (handoff.text) {
    lines.push(`> ${handoff.text.split('\n').join('\n> ')}`);
    lines.push('');
  }

  lines.push('## Parties');
  lines.push(mdTable([
    ['From', handoff.from ?? '—'],
    ['To', handoff.to ?? '—'],
    ['Status', handoff.status ?? '—'],
    ['Plan', handoff.plan_id ?? '—'],
    ['Claim', handoff.claim_id ?? '—'],
  ]));
  lines.push('');

  const summary = handoff.summary ?? handoff.work_summary;
  if (summary) {
    lines.push('## Summary');
    lines.push(summary);
    lines.push('');
  }

  lines.push('## Timeline');
  lines.push(mdTable([
    ['Created', formatTime(handoff.created_at)],
    ['Updated', formatTime(handoff.updated_at)],
  ]));
  lines.push('');

  lines.push('---');
  lines.push(`_id:_ \`${handoff.id}\``);
  lines.push(renderRefreshLink(args));

  return lines.join('\n');
}

function renderAgent(agent: Record<string, any>, args: OpenEntityArgs): string {
  const lines: string[] = [];
  lines.push(`# Agent · ${agent.name ?? agent.id}`);
  lines.push('');

  lines.push('## Details');
  lines.push(mdTable([
    ['Trust', agent.trust_level ?? '—'],
    ['Profile', agent.profile ?? '—'],
    ['Claims', String(agent.claim_count ?? 0)],
    ['Session', agent.has_open_session ? 'open' : 'closed'],
    ['Scopes', formatList(agent.scopes)],
    ['Capabilities', formatList(agent.capabilities)],
  ]));
  lines.push('');

  lines.push('## Activity');
  lines.push(mdTable([
    ['Last active', formatTime(agent.last_active_at)],
    ['Registered', formatTime(agent.created_at)],
  ]));
  lines.push('');

  lines.push('---');
  lines.push(`_id:_ \`${agent.id ?? agent.name}\``);
  lines.push(renderRefreshLink(args));

  return lines.join('\n');
}

// --- Helpers ---

function mdTable(rows: Array<[string, string]>): string {
  const body = rows.map(([k, v]) => `| **${k}** | ${escapeTableCell(v)} |`).join('\n');
  return `| Field | Value |\n|---|---|\n${body}`;
}

function escapeTableCell(value: string): string {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatList(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '—';
  return value.map((v) => `\`${String(v)}\``).join(', ');
}

function formatTime(iso: string | undefined | null): string {
  if (!iso) return '';
  try {
    const ago = timeAgo(iso);
    return `${iso} _(${ago})_`;
  } catch {
    return String(iso);
  }
}

function renderCommandLink(label: string, command: string, args: unknown): string {
  const encoded = encodeURIComponent(JSON.stringify([args]));
  return `[${label}](command:${command}?${encoded})`;
}

function renderRefreshLink(args: OpenEntityArgs): string {
  return renderCommandLink('↻ Refresh', 'brainclaw.refreshEntityPreview', args);
}

function buildFakeItem(projectPath: string, itemId: string): Record<string, unknown> {
  return { projectPath, itemId };
}

function renderError(title: string, detail: string): string {
  const lines = [`# ⚠ ${title}`, ''];
  if (detail) lines.push('```', detail, '```');
  return lines.join('\n');
}
