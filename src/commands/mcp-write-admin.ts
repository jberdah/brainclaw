/**
 * MCP admin / provisioning write-tool handlers.
 *
 * Extracted from mcp.ts (pln#622 PR4) — mechanical move of the setup wizard,
 * project init, and capability/tool registration write handlers. Behavior is
 * unchanged; each handler receives the tool-call payload plus a
 * {@link McpWriteAdminContext} carrying the model resolved once per write call.
 *
 * This module must never import ./mcp.js (dependency-direction guard,
 * pln#622 PR1).
 *
 * @module
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { memoryExists } from '../core/io.js';
import { appendAuditEntry } from '../core/audit.js';
import { createCapability, createTool as createRegistryTool } from '../core/registries.js';
import { detectAiAgent } from '../core/ai-agent-detection.js';
import {
  checkGitPresence,
  scanGitRepos,
  parseRoots,
  parseRepoSelection,
  parseAgentSelection,
  getDetectedSetupAgentNames,
  getInstalledAgentNames,
  runGlobalInstall,
  initReposAndConfigureAgents,
  readSetupState,
  ALL_KNOWN_AGENTS,
} from './setup.js';
import { buildAgentInventory } from '../core/agent-inventory.js';
import { probeForQuickSetup, buildQuickSetupProbeResponse, buildOnboardingPreview, resolveEmptyMemoryRecommendation, type ProjectTypeChoice, type TopologyChoice } from '../core/setup-flow.js';
import { ensureUserStore, resolveHomeDir } from '../core/setup-state.js';
import { ensureTrust } from './mcp-write-support.js';
import {
  SCHEMA_VERSION,
  toolResponse,
  createToolErrorResponse,
  type McpToolExecutionPayload,
  type McpToolExecutionOutcome,
} from './mcp-contract.js';

/**
 * Per-call context for the extracted admin write handlers. `currentModel` is
 * resolved once per write call at the mcp.ts assembly point and stamped on
 * newly registered capabilities/tools.
 */
export interface McpWriteAdminContext {
  /** Model resolved once for all write operations in the assembly point. */
  currentModel?: string;
}

export async function handleBclawSetup(payload: McpToolExecutionPayload, _ctx: McpWriteAdminContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd } = payload;
  const step = args.step as string | undefined;
  const choice = (args.choice as string | undefined) ?? '';
  const rootsArg = args.roots as string | undefined;
  const repoSelectionArg = args.repo_selection as string | undefined;
  const modeArg = args.mode as string | undefined;
  const env = process.env;

  if (!checkGitPresence()) {
    return { response: toolResponse({ content: [{ type: 'text', text: 'Git is not installed or not found in PATH. Install git from https://git-scm.com before running brainclaw setup.' }], structuredContent: { error: 'git_not_found' } }, true) };
  }

  // ─── Quick mode: probe current repo ──────────────────────────────
  if (!step) {
    // Auto-detect mode: if we're in a git repo, use quick mode unless batch is forced
    const forceBatch = modeArg === 'batch';
    if (!forceBatch) {
      const probe = probeForQuickSetup(cwd);
      if (probe.isGitRepo || probe.alreadyInitialized) {
        const response = buildQuickSetupProbeResponse(probe);
        return { response: toolResponse({ content: [{ type: 'text', text: response.text }], structuredContent: response.structured }) };
      }
    }

    // Fall through to batch mode
    const existingState = readSetupState(env);
    const alreadyRun = existingState ? `Setup was previously run on ${new Date(existingState.completed_at).toLocaleDateString()}. You can re-run it.` : undefined;
    return { response: toolResponse({ content: [{ type: 'text', text: [alreadyRun, "Where are the user's project directories? Please ask the user to provide one or more root paths where their git repositories are located (e.g. ~/Projects, C:\\Users\\user\\code)."].filter(Boolean).join('\n\n') }], structuredContent: { pending_question: 'project_roots', prompt: 'Please ask the user: "Where are your projects? Enter one or more root directories (comma-separated):"', ...(alreadyRun ? { already_run: alreadyRun } : {}) } }) };
  }

  // ─── Quick mode step: init with choices ──────────────────────────
  if (step === 'quick_init') {
    const projectType = (args.project_type as ProjectTypeChoice | undefined) ?? 'standalone';
    const topology = (args.topology as TopologyChoice | undefined) ?? 'embedded';

    // Ensure user store exists
    ensureUserStore(env);

    // Map choices to init options
    const projectMode = projectType === 'workspace' ? 'multi-project' as const : 'auto' as const;
    const topologyMode = topology === 'sidecar' ? 'sidecar' as const : 'embedded' as const;

    // Run init
    try {
      const { runInit } = await import('./init.js');
      await runInit({
        yes: true,
        cwd,
        skipAgentBootstrap: false,
        projectMode,
        topology: topologyMode,
      });
    } catch (err) {
      return { response: toolResponse({ content: [{ type: 'text', text: `Init failed: ${err instanceof Error ? err.message : String(err)}` }], structuredContent: { error: 'init_failed', details: err instanceof Error ? err.message : String(err) } }, true) };
    }

    // Detect agent and report
    const detected = detectAiAgent(env);
    const summary: string[] = [
      `✔ Initialized ${cwd.split(/[\\/]/).pop() ?? cwd} (${projectType}, ${topology})`,
    ];
    if (detected) {
      summary.push(`✔ Agent detected: ${detected.name}`);
    }
    summary.push('✔ Full brainclaw MCP catalog activates automatically; reload your agent session only if new tools do not appear.');

    // Bootstrap route follows the shared empty-memory rule; the preview
    // already embeds the same recommendation text when memory is empty.
    const probe = probeForQuickSetup(cwd);
    const bootstrapAvailable = probe.hasContent;
    const emptyMemoryRec = resolveEmptyMemoryRecommendation(cwd);
    const preview = buildOnboardingPreview(cwd);

    return {
      response: toolResponse({
        content: [{ type: 'text', text: summary.join('\n') + '\n\n' + preview }],
        structuredContent: {
          setup_complete: true,
          project_type: projectType,
          topology,
          detected_agent: detected?.name ?? null,
          bootstrap_available: bootstrapAvailable,
          bootstrap_route: emptyMemoryRec.route,
          next_action: emptyMemoryRec.mcp_next_action,
          preview,
          summary,
        },
      }),
    };
  }

  if (step === 'project_roots') {
    const roots = parseRoots(choice, env);
    if (roots.length === 0) {
      return { response: toolResponse({ content: [{ type: 'text', text: 'No valid directories found from the provided paths. Please ask the user for valid root directories.' }], structuredContent: { error: 'no_valid_roots', provided: choice } }, true) };
    }
    const repos = scanGitRepos(roots);
    const repoList = repos.map((r, i) => `  ${i + 1}) ${r.alreadyInitialised ? '[✔ init]' : '[      ]'} ${r.name}  (${r.path})`).join('\n');
    return { response: toolResponse({ content: [{ type: 'text', text: `Found ${repos.length} repository candidate(s):\n${repoList}\n\nAsk the user which repositories to initialise.` }], structuredContent: { pending_question: 'repo_selection', roots: roots.join(','), repos: repos.map((r) => ({ path: r.path, name: r.name, alreadyInitialised: r.alreadyInitialised })), prompt: 'Please ask the user: "Which repositories to initialise? Reply: (a)ll, (c)urrent, or numbers like 1,3"' } }) };
  }

  if (step === 'repo_selection') {
    if (!rootsArg) {
      return { response: toolResponse({ content: [{ type: 'text', text: 'Missing roots parameter. Pass the roots value from the previous step.' }], structuredContent: { error: 'missing_roots' } }, true) };
    }
    const roots = parseRoots(rootsArg, env);
    const repos = scanGitRepos(roots);
    const selectedRepos = parseRepoSelection(choice, repos, cwd);
    const detected = detectAiAgent(env);
    const installedAgents = getInstalledAgentNames(buildAgentInventory(resolveHomeDir(env) ?? os.homedir(), env));
    const detectedSetupAgents = getDetectedSetupAgentNames(detected?.name, installedAgents);
    const agentList = ALL_KNOWN_AGENTS.map((a, i) => {
      const tag = a === detected?.name ? ' ← detected' : installedAgents.includes(a) ? ' ← installed' : '';
      return `  ${i + 1}) ${a}${tag}`;
    }).join('\n');
    const detectedLine = detectedSetupAgents.length > 0 ? `\nDetected install set: ${detectedSetupAgents.join(', ')}\n` : '\n';
    return { response: toolResponse({ content: [{ type: 'text', text: `Selected ${selectedRepos.length} repo(s). Detected AI agent: ${detected?.name ?? 'none'}.${detectedLine}\nAvailable agents:\n${agentList}\n\nAsk the user which agents to configure.` }], structuredContent: { pending_question: 'agent_selection', roots: rootsArg, repo_selection: choice, selected_repos: selectedRepos.map((r) => ({ path: r.path, name: r.name })), detected_agent: detected?.name ?? null, installed_agents: installedAgents, detected_setup_agents: detectedSetupAgents, all_agents: ALL_KNOWN_AGENTS, prompt: 'Please ask the user: "Which agents to configure? Reply: (d)etected installed, (a)ll, or agent names like claude-code,cursor"' } }) };
  }

  if (step === 'agent_selection') {
    if (!rootsArg || !repoSelectionArg) {
      return { response: toolResponse({ content: [{ type: 'text', text: 'Missing roots or repo_selection parameter from previous steps.' }], structuredContent: { error: 'missing_params' } }, true) };
    }
    const roots = parseRoots(rootsArg, env);
    const repos = scanGitRepos(roots);
    const selectedRepos = parseRepoSelection(repoSelectionArg, repos, cwd);
    const detected = detectAiAgent(env);
    const installedAgents = getInstalledAgentNames(buildAgentInventory(resolveHomeDir(env) ?? os.homedir(), env));
    const selectedAgents = parseAgentSelection(choice, detected?.name, installedAgents);
    const summary: string[] = [];
    const written = runGlobalInstall(selectedAgents, env);
    for (const f of written) summary.push(`✔ Global config: ${f}`);
    const { initialisedRepos, configActions } = await initReposAndConfigureAgents(selectedRepos, selectedAgents, env);
    for (const p of initialisedRepos) summary.push(`✔ Initialised repo: ${p}`);
    for (const a of configActions) summary.push(a);
    let reloadMsg = '✔ Setup complete! Reload your AI agent session to activate brainclaw MCP tools.';
    if (detected?.name === 'claude-code') reloadMsg += '\n  → In VS Code: Cmd/Ctrl+Shift+P → "Claude: Reload MCP Servers"';
    else if (detected?.name === 'cursor') reloadMsg += '\n  → In Cursor: restart the editor';
    else if (detected?.name === 'windsurf') reloadMsg += '\n  → In Windsurf: restart the editor';
    return { response: toolResponse({ content: [{ type: 'text', text: [reloadMsg, '', ...summary].join('\n') }], structuredContent: { setup_complete: true, initialised_repos: initialisedRepos, global_configs_written: written, agent_configs_written: configActions, detected_agent: detected?.name ?? null, summary } }) };
  }

  return { response: toolResponse({ content: [{ type: 'text', text: `Unknown step: "${step}". Valid steps: project_roots, repo_selection, agent_selection.` }], structuredContent: { error: 'unknown_step', step } }, true) };
}

export async function handleBclawInitProject(payload: McpToolExecutionPayload, _ctx: McpWriteAdminContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd } = payload;
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!rawPath) {
    return { response: createToolErrorResponse('validation_error', 'path is required') };
  }
  const force = args.force === true;
  const projectModeArg = typeof args.project_mode === 'string' ? args.project_mode : undefined;
  const linkAs = typeof args.link_as === 'string' && args.link_as.trim().length > 0
    ? args.link_as.trim()
    : undefined;

  const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);

  let wasAlreadyInitialized = false;
  if (memoryExists(resolvedPath) && !force) {
    wasAlreadyInitialized = true;
  } else {
    if (!fs.existsSync(resolvedPath)) {
      try {
        fs.mkdirSync(resolvedPath, { recursive: true });
      } catch (err) {
        return {
          response: createToolErrorResponse(
            'init_project_failed',
            `Failed to create target directory '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`,
          ),
        };
      }
    }
    try {
      const { runInit } = await import('./init.js');
      await runInit({
        yes: true,
        cwd: resolvedPath,
        force,
        ...(projectModeArg ? { projectMode: projectModeArg as 'single-project' | 'multi-project' | 'auto' } : {}),
      });
    } catch (err) {
      return {
        response: createToolErrorResponse(
          'init_project_failed',
          `runInit failed for '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }
  }

  let projectName: string;
  try {
    projectName = loadConfig(resolvedPath).project_name;
  } catch {
    projectName = path.basename(resolvedPath);
  }

  let linkName: string;
  try {
    const { addCrossProjectLink } = await import('../core/cross-project.js');
    const link = addCrossProjectLink({
      path: resolvedPath,
      name: linkAs ?? projectName,
      cwd,
      force,
    });
    linkName = link.name ?? path.basename(resolvedPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Treat a duplicate link as idempotent success when the caller did
    // not request --force; the project itself is initialised correctly
    // and the existing link already points at it.
    if (/already exists/i.test(message) && !force) {
      try {
        const { resolveCrossProjectLinks } = await import('../core/cross-project.js');
        const existing = resolveCrossProjectLinks(cwd).find(
          (l) => l.absolutePath === resolvedPath || l.path === rawPath,
        );
        linkName = existing?.name ?? linkAs ?? projectName;
      } catch {
        linkName = linkAs ?? projectName;
      }
    } else {
      return {
        response: createToolErrorResponse('init_project_failed', `Failed to register cross_project_link: ${message}`),
      };
    }
  }

  const summary = wasAlreadyInitialized
    ? `✔ ${resolvedPath} already initialised; linked as '${linkName}'.`
    : `✔ Initialised brainclaw at ${resolvedPath} and linked as '${linkName}'.`;

  return {
    response: toolResponse({
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        status: 'ok',
        project_name: projectName,
        path: resolvedPath,
        link_id: linkName,
        was_already_initialized: wasAlreadyInitialized,
      },
    }),
  };
}

export function handleBclawAddCapability(payload: McpToolExecutionPayload, ctx: McpWriteAdminContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const capName = String(args.name ?? '').trim();
  const capDesc = String(args.description ?? '').trim();
  if (!capName || !capDesc) {
    return { response: createToolErrorResponse('validation_error', 'Missing required arguments: name and description') };
  }
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const resolvedIdentity = resolved.identity!;
  const extraTags = Array.isArray(args.tags) ? args.tags as string[] : [];
  const cap = createCapability({
    name: capName,
    description: capDesc,
    tags: extraTags,
    author: resolvedIdentity.agent_name,
    authorId: resolvedIdentity.agent_id,
    model: ctx.currentModel,
  }, cwd);
  appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'create', item_id: cap.id, item_type: 'capability', reason: `capability: ${capName}` }, cwd);
  return {
    response: toolResponse({
      content: [{ type: 'text', text: `✔ Capability registered: [${cap.id}] ${capName}` }],
      id: cap.id,
      name: capName,
      schema_version: SCHEMA_VERSION,
    }),
  };
}

export function handleBclawAddTool(payload: McpToolExecutionPayload, ctx: McpWriteAdminContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const toolName = String(args.name ?? '').trim();
  const toolDesc = String(args.description ?? '').trim();
  if (!toolName || !toolDesc) {
    return { response: createToolErrorResponse('validation_error', 'Missing required arguments: name and description') };
  }
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const resolvedIdentity = resolved.identity!;
  const toolType = String(args.type ?? 'utility');
  const extraTags = Array.isArray(args.tags) ? args.tags as string[] : [];
  const tool = createRegistryTool({
    name: toolName,
    description: toolDesc,
    type: toolType,
    tags: extraTags,
    author: resolvedIdentity.agent_name,
    authorId: resolvedIdentity.agent_id,
    model: ctx.currentModel,
  }, cwd);
  appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'create', item_id: tool.id, item_type: 'tool', reason: `tool: ${toolName}` }, cwd);
  return {
    response: toolResponse({
      content: [{ type: 'text', text: `✔ Tool registered: [${tool.id}] ${toolName} (${toolType})` }],
      id: tool.id,
      name: toolName,
      type: toolType,
      schema_version: SCHEMA_VERSION,
    }),
  };
}
