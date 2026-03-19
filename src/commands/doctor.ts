import { listAgentIdentities, resolveCurrentAgentIdentity } from '../core/agent-registry.js';
import { buildReputationSummary } from '../core/reputation.js';
import { buildCircuitBreakerSnapshot } from '../core/circuit-breaker.js';
import { loadState } from '../core/state.js';
import { loadConfig } from '../core/config.js';
import { doctorCheck } from '../core/security.js';
import { getVisibleMemoryVersion, readContextMarker } from '../core/freshness.js';
import { generateMarkdown } from '../core/markdown.js';
import { loadProjectIdentity, projectIdentityExists } from '../core/project-registry.js';
import { findInstructionConflicts, loadInstructions } from '../core/instructions.js';
import { memoryExists, memoryPath, readFileSync } from '../core/io.js';
import { logger } from '../core/logger.js';
import { listCandidates, listArchivedCandidates } from '../core/candidates.js';
import { listClaims } from '../core/claims.js';
import { listRuntimeNotes } from '../core/runtime.js';
import { isTrapExpired, listOperationalTraps } from '../core/traps.js';
import { scanText } from '../core/security.js';
import { listRuntimeEvents } from '../core/events.js';
import { resolveEventSessionId } from '../core/identity.js';
import { detectContradictions } from '../core/contradictions.js';
import { scanMigrationStatus } from '../core/migration.js';
import { buildAgentToolingContext } from '../core/agent-context.js';
import { assessAgentIntegrationReadiness } from '../core/agent-integrations.js';
import { assessBrainclawVersion } from '../core/brainclaw-version.js';
import { resolveStoreChain } from '../core/store-resolution.js';
import { resolveCrossProjectLinks, detectCrossProjectCycles } from '../core/cross-project.js';
import { auditLocalAgentWorkspaceFiles, ensureGitignoreEntries } from '../core/agent-files.js';

const BACKLOG_KEYWORDS = /\b(TODO|NEXT|backlog|next[\s-]step|action[\s-]item|prochaine?s?\s+étapes?|à\s+faire)\b/i;

function hasBacklogPatterns(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const bulletOrNumbered = lines.some(
    (l) => /^\s*[-*•]\s+\w/.test(l) || /^\s*\d+\.\s+\w/.test(l),
  );
  return bulletOrNumbered || BACKLOG_KEYWORDS.test(text) || /\[[ x]\]/.test(text);
}

export interface DoctorOptions {
  json?: boolean;
  cwd?: string;
  migrationCheck?: boolean;
  fixAgentIgnore?: boolean;
}

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  details?: unknown;
}

export function runDoctor(options: DoctorOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let hasIssues = false;
  const checks: DoctorCheck[] = [];
  let migrationEntries = [] as ReturnType<typeof scanMigrationStatus>;
  let agentGitHygieneFixed: string[] = [];

  // Validate config
  let config;
  try {
    config = loadConfig(options.cwd);
    checks.push({ name: 'config', status: 'ok', message: 'config.yaml is valid' });
    if (!options.json) {
      console.log('✔ config.yaml is valid');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'config', status: 'error', message: `config.yaml is invalid: ${msg}` });
    console.error(`✗ config.yaml is invalid: ${msg}`);
    hasIssues = true;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, checks, metrics: {} }, null, 2));
    }
    return;
  }

  if (options.fixAgentIgnore) {
    const initialAudit = auditLocalAgentWorkspaceFiles(options.cwd ?? process.cwd());
    if (initialAudit.missingGitignorePaths.length > 0) {
      ensureGitignoreEntries(options.cwd ?? process.cwd(), initialAudit.missingGitignorePaths);
      agentGitHygieneFixed = initialAudit.missingGitignorePaths;
      if (!options.json) {
        console.log(`✔ Added generated local agent files to .gitignore: ${agentGitHygieneFixed.join(', ')}`);
      }
    }
  }

  // Validate state
  let state;
  try {
    state = loadState(options.cwd);
    checks.push({ name: 'state', status: 'ok', message: 'state is valid' });
    if (!options.json) {
      console.log('✔ state is valid');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'state', status: 'error', message: `state is invalid: ${msg}` });
    console.error(`✗ state is invalid: ${msg}`);
    hasIssues = true;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, checks, metrics: {} }, null, 2));
    }
    return;
  }

  if (options.migrationCheck) {
    migrationEntries = scanMigrationStatus(options.cwd);
    const outdated = migrationEntries.filter((entry) => entry.status === 'outdated');
    const invalid = migrationEntries.filter((entry) => entry.status === 'invalid');

    if (outdated.length > 0) {
      checks.push({
        name: 'schema_migrations',
        status: 'warn',
        message: `${outdated.length} document(s) require schema migration.`,
      });
      if (!options.json) {
        console.warn(`⚠ ${outdated.length} document(s) require schema migration.`);
        for (const entry of outdated.slice(0, 20)) {
          console.warn(`  - ${entry.path} [${entry.documentType}] v${entry.detectedVersion} -> v${entry.currentVersion}`);
        }
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'schema_migrations',
        status: 'ok',
        message: 'No documents require schema migration',
      });
      if (!options.json) {
        console.log('✔ No documents require schema migration');
      }
    }

    if (invalid.length > 0) {
      checks.push({
        name: 'schema_migration_errors',
        status: 'error',
        message: `${invalid.length} document(s) are invalid or unreadable for migration.`,
      });
      if (!options.json) {
        console.warn(`⚠ ${invalid.length} document(s) are invalid or unreadable for migration.`);
        for (const entry of invalid.slice(0, 20)) {
          console.warn(`  - ${entry.path} [${entry.documentType}] ${entry.error ?? 'invalid document'}`);
        }
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'schema_migration_errors',
        status: 'ok',
        message: 'No invalid versioned documents found',
      });
    }
  }

  if (config.project_mode === 'multi-project' && (config.projects?.known.length ?? 0) === 0) {
    checks.push({
      name: 'project_mode',
      status: 'warn',
      message: 'project_mode is multi-project but no project namespaces are configured yet.',
    });
    if (!options.json) {
      console.warn('⚠ project_mode is multi-project but no project namespaces are configured yet.');
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'project_mode',
      status: 'ok',
      message: `project_mode=${config.project_mode}, strategy=${config.projects?.strategy ?? 'manual'}, known_projects=${config.projects?.known.length ?? 0}`,
    });
    if (!options.json) {
      console.log(`✔ project mode: ${config.project_mode} (${config.projects?.strategy ?? 'manual'})`);
    }
  }

  try {
    if (projectIdentityExists(options.cwd)) {
      const projectIdentity = loadProjectIdentity(options.cwd);
      if (!config.project_id) {
        checks.push({
          name: 'project_identity',
          status: 'warn',
          message: `project.identity.json exists but config.yaml has no project_id. Expected ${projectIdentity.project_id}.`,
        });
        if (!options.json) {
          console.warn(`⚠ project.identity.json exists but config.yaml has no project_id. Expected ${projectIdentity.project_id}.`);
        }
        hasIssues = true;
      } else if (config.project_id !== projectIdentity.project_id) {
        checks.push({
          name: 'project_identity',
          status: 'warn',
          message: `project_id mismatch between config.yaml (${config.project_id}) and project.identity.json (${projectIdentity.project_id}).`,
        });
        if (!options.json) {
          console.warn(`⚠ project_id mismatch between config.yaml (${config.project_id}) and project.identity.json (${projectIdentity.project_id}).`);
        }
        hasIssues = true;
      } else {
        checks.push({
          name: 'project_identity',
          status: 'ok',
          message: `project_id=${projectIdentity.project_id}`,
        });
        if (!options.json) {
          console.log(`✔ project identity: ${projectIdentity.project_id}`);
        }
      }
    } else if (config.project_id) {
      checks.push({
        name: 'project_identity',
        status: 'warn',
        message: `config.yaml has project_id=${config.project_id} but project.identity.json is missing.`,
      });
      if (!options.json) {
        console.warn(`⚠ config.yaml has project_id=${config.project_id} but project.identity.json is missing.`);
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'project_identity',
        status: 'ok',
        message: 'No project identity configured yet',
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'project_identity', status: 'warn', message: `project identity is invalid: ${msg}` });
    if (!options.json) {
      console.warn(`⚠ project identity is invalid: ${msg}`);
    }
    hasIssues = true;
  }

  try {
    const registeredAgents = listAgentIdentities(options.cwd);
    if (config.current_agent || config.current_agent_id) {
      const currentAgent = resolveCurrentAgentIdentity(options.cwd);
      if (!currentAgent) {
        checks.push({
          name: 'agent_identity',
          status: 'warn',
          message: `Current agent is configured (${config.current_agent ?? 'unknown'} / ${config.current_agent_id ?? 'unknown'}) but no matching registry entry was found.`,
        });
        if (!options.json) {
          console.warn(`⚠ Current agent is configured (${config.current_agent ?? 'unknown'} / ${config.current_agent_id ?? 'unknown'}) but no matching registry entry was found.`);
        }
        hasIssues = true;
      } else if ((config.current_agent && config.current_agent !== currentAgent.agent_name)
        || (config.current_agent_id && config.current_agent_id !== currentAgent.agent_id)) {
        checks.push({
          name: 'agent_identity',
          status: 'warn',
          message: `Current agent config does not match registry entry (${currentAgent.agent_name} / ${currentAgent.agent_id}).`,
        });
        if (!options.json) {
          console.warn(`⚠ Current agent config does not match registry entry (${currentAgent.agent_name} / ${currentAgent.agent_id}).`);
        }
        hasIssues = true;
      } else {
        checks.push({
          name: 'agent_identity',
          status: 'ok',
          message: `current_agent=${currentAgent.agent_name}, agent_id=${currentAgent.agent_id}, registered_agents=${registeredAgents.length}`,
        });
        if (!options.json) {
          console.log(`✔ current agent: ${currentAgent.agent_name} (${currentAgent.agent_id})`);
        }
      }
    } else {
      checks.push({
        name: 'agent_identity',
        status: 'ok',
        message: `No current agent configured (${registeredAgents.length} registered agent(s))`,
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'agent_identity', status: 'warn', message: `agent identity is invalid: ${msg}` });
    if (!options.json) {
      console.warn(`⚠ agent identity is invalid: ${msg}`);
    }
    hasIssues = true;
  }

  // Warn if no curator is registered
  try {
    const allAgents = listAgentIdentities(options.cwd);
    const hasCurator = allAgents.some((a) => a.trust_level === 'curator');
    if (!hasCurator && allAgents.length > 0) {
      checks.push({
        name: 'no_curator',
        status: 'warn',
        message: 'No curator registered. Run `brainclaw set-trust <agent> --level curator` or `brainclaw register-agent <name> --curator` to designate a project owner.',
      });
      if (!options.json) {
        console.warn('⚠ No curator registered — run `brainclaw set-trust <agent> --level curator` to designate a project owner.');
      }
    }
  } catch { /* non-fatal */ }

  const agentTooling = buildAgentToolingContext({ cwd: options.cwd });
  if (agentTooling.agents_md_present && agentTooling.agents_rules.length === 0) {
    checks.push({
      name: 'agent_rules',
      status: 'warn',
      message: 'AGENTS.md is present but no actionable rules were extracted.',
    });
    if (!options.json) {
      console.warn('⚠ AGENTS.md is present but no actionable rules were extracted.');
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_rules',
      status: 'ok',
      message: agentTooling.agents_md_present
        ? `${agentTooling.agents_rules.length} actionable agent rule(s) detected`
        : 'No AGENTS.md detected',
    });
  }

  const incompleteSkills = agentTooling.skills.filter((skill) => !skill.description && !skill.scripts_present && !skill.references_present && !skill.assets_present);
  if (incompleteSkills.length > 0) {
    checks.push({
      name: 'agent_skills',
      status: 'warn',
      message: `${incompleteSkills.length} skill(s) look incomplete or under-described.`,
    });
    if (!options.json) {
      console.warn(`⚠ ${incompleteSkills.length} skill(s) look incomplete or under-described.`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_skills',
      status: 'ok',
      message: `${agentTooling.skills.length} skill(s) inventoried`,
    });
  }

  const missingMcpCommands = agentTooling.mcp_servers.filter((server) => server.availability === 'missing_command');
  if (missingMcpCommands.length > 0) {
    checks.push({
      name: 'agent_mcp',
      status: 'warn',
      message: `${missingMcpCommands.length} stdio MCP server(s) are configured with a missing local command.`,
    });
    if (!options.json) {
      console.warn(`⚠ ${missingMcpCommands.length} stdio MCP server(s) are configured with a missing local command.`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_mcp',
      status: 'ok',
      message: `${agentTooling.mcp_servers.length} MCP server(s) inventoried`,
    });
  }

  const integrationReadiness = assessAgentIntegrationReadiness(config, options.cwd ?? process.cwd());
  const missingIntegrations = integrationReadiness.filter((entry) => !entry.ready);
  if (missingIntegrations.length > 0) {
    checks.push({
      name: 'agent_integrations',
      status: 'warn',
      message: `${missingIntegrations.length} declared agent integration(s) are not fully activated on this machine/workspace.`,
      details: missingIntegrations,
    });
    if (!options.json) {
      console.warn(`⚠ ${missingIntegrations.length} declared agent integration(s) are not fully activated on this machine/workspace.`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_integrations',
      status: 'ok',
      message: `${integrationReadiness.length} declared agent integration(s) are fully activated`,
    });
  }

  const agentGitHygiene = auditLocalAgentWorkspaceFiles(options.cwd ?? process.cwd());
  if (!agentGitHygiene.isGitRepo) {
    checks.push({
      name: 'agent_git_hygiene',
      status: 'ok',
      message: 'No Git worktree detected; agent git hygiene audit skipped',
    });
  } else if (agentGitHygiene.presentPaths.length === 0) {
    checks.push({
      name: 'agent_git_hygiene',
      status: 'ok',
      message: 'No local-only Brainclaw agent files detected in the workspace',
    });
  } else if (agentGitHygiene.hasIssues) {
    const parts: string[] = [];
    if (agentGitHygiene.missingGitignorePaths.length > 0) {
      parts.push(`${agentGitHygiene.missingGitignorePaths.length} file(s) should be added to .gitignore`);
    }
    if (agentGitHygiene.trackedPaths.length > 0) {
      parts.push(`${agentGitHygiene.trackedPaths.length} file(s) are still tracked by Git`);
    }
    const fixHint = agentGitHygiene.missingGitignorePaths.length > 0
      ? ' Run `brainclaw doctor --fix-agent-ignore` to add ignore entries.'
      : '';
    checks.push({
      name: 'agent_git_hygiene',
      status: 'warn',
      message: `${parts.join('; ')}.${fixHint}`.trim(),
      details: agentGitHygiene,
    });
    if (!options.json) {
      console.warn(`⚠ Agent git hygiene: ${parts.join('; ')}.`);
      if (agentGitHygiene.missingGitignorePaths.length > 0) {
        console.warn(`  Missing .gitignore entries: ${agentGitHygiene.missingGitignorePaths.join(', ')}`);
        console.warn('  Fix: run `brainclaw doctor --fix-agent-ignore`');
      }
      if (agentGitHygiene.trackedPaths.length > 0) {
        console.warn(`  Tracked local agent files: ${agentGitHygiene.trackedPaths.join(', ')}`);
        console.warn('  After updating .gitignore, untrack them with `git rm --cached <path>` as needed.');
      }
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_git_hygiene',
      status: 'ok',
      message: `${agentGitHygiene.presentPaths.length} local-only Brainclaw agent file(s) are ignored correctly`,
      details: agentGitHygiene,
    });
    if (!options.json) {
      console.log(`✔ Agent git hygiene: ${agentGitHygiene.presentPaths.length} local-only file(s) are ignored correctly`);
    }
  }

  const brainclawVersion = assessBrainclawVersion(config);
  if (brainclawVersion.status === 'upgrade_required' || brainclawVersion.status === 'invalid_config') {
    checks.push({
      name: 'brainclaw_version',
      status: 'warn',
      message: brainclawVersion.message,
      details: brainclawVersion,
    });
    if (!options.json) {
      console.warn(`⚠ ${brainclawVersion.message}`);
      if (brainclawVersion.upgrade_message) {
        console.warn(`  Benefits: ${brainclawVersion.upgrade_message}`);
      }
      if (brainclawVersion.upgrade_command) {
        console.warn(`  Upgrade: ${brainclawVersion.upgrade_command}`);
      }
    }
    hasIssues = true;
  } else if (brainclawVersion.status === 'update_available') {
    checks.push({
      name: 'brainclaw_version',
      status: 'warn',
      message: brainclawVersion.message,
      details: brainclawVersion,
    });
    if (!options.json) {
      console.warn(`⚠ ${brainclawVersion.message}`);
      if (brainclawVersion.upgrade_message) {
        console.warn(`  Benefits: ${brainclawVersion.upgrade_message}`);
      }
      if (brainclawVersion.upgrade_command) {
        console.warn(`  Upgrade: ${brainclawVersion.upgrade_command}`);
      }
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'brainclaw_version',
      status: 'ok',
      message: brainclawVersion.message,
    });
    if (!options.json) {
      console.log(`✔ ${brainclawVersion.message}`);
    }
  }

  // Check project.md consistency
  try {
    const currentMd = readFileSync(memoryPath('project.md', options.cwd));
    const expectedMd = generateMarkdown(state, options.cwd);
    if (currentMd === expectedMd) {
      checks.push({ name: 'markdown_sync', status: 'ok', message: 'project.md is in sync with state' });
      if (!options.json) {
        console.log('✔ project.md is in sync with state');
      }
    } else {
      checks.push({ name: 'markdown_sync', status: 'warn', message: 'project.md is out of sync with state. Run `brainclaw rebuild` to fix.' });
      console.warn('⚠ project.md is out of sync with state. Run `brainclaw rebuild` to fix.');
      hasIssues = true;
    }
  } catch (err) {
    logger.debug('Failed to check project.md sync:', err);
    checks.push({ name: 'markdown_sync', status: 'warn', message: 'project.md is missing. Run `brainclaw rebuild` to regenerate.' });
    console.warn('⚠ project.md is missing. Run `brainclaw rebuild` to regenerate.');
    hasIssues = true;
  }

  // Security scan on state
  const warnings = doctorCheck(state, config);
  if (warnings.length === 0) {
    checks.push({ name: 'state_security', status: 'ok', message: 'No sensitive content detected in state' });
    if (!options.json) {
      console.log('✔ No sensitive content detected in state');
    }
  } else {
    hasIssues = true;
    checks.push({ name: 'state_security', status: 'warn', message: `${warnings.length} sensitive content warning(s) detected in state` });
    if (!options.json) {
      console.log('');
      console.log('State warnings:');
    }
    for (const w of warnings) {
      if (!options.json) {
        console.warn(`  - ${w.message}`);
      }
    }
  }

  const planItems = state.plan_items;
  const instructions = loadInstructions(options.cwd);
  const activePlans = planItems.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
  const blockedPlans = planItems.filter((plan) => plan.status === 'blocked');
  const unassignedInProgress = planItems.filter((plan) => plan.status === 'in_progress' && !plan.assignee);

  if (!options.json) {
    console.log(`✔ Shared plan: ${activePlans.length} active, ${blockedPlans.length} blocked`);
  }

  if (unassignedInProgress.length > 0) {
    checks.push({
      name: 'plan_assignment',
      status: 'warn',
      message: `${unassignedInProgress.length} in-progress plan item(s) have no assignee.`,
    });
    if (!options.json) {
      console.warn(`⚠ ${unassignedInProgress.length} in-progress plan item(s) have no assignee.`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'plan_assignment',
      status: 'ok',
      message: 'All in-progress plan items have an assignee',
    });
  }

  const unknownProjects = activePlans
    .map((plan) => plan.project)
    .filter((project): project is string => typeof project === 'string' && project.length > 0)
    .filter((project) => config.project_mode === 'multi-project' && !config.projects.known.includes(project));
  if (unknownProjects.length > 0) {
    const deduped = [...new Set(unknownProjects)];
    checks.push({
      name: 'plan_projects',
      status: 'warn',
      message: `Plan items reference unknown project namespace(s): ${deduped.join(', ')}`,
    });
    if (!options.json) {
      console.warn(`⚠ Plan items reference unknown project namespace(s): ${deduped.join(', ')}`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'plan_projects',
      status: 'ok',
      message: 'Plan items reference known project namespaces',
    });
  }

  const activeInstructions = instructions.filter((entry) => entry.active);
  const instructionConflicts = findInstructionConflicts(instructions);
  if (!options.json) {
    console.log(`✔ Shared instructions: ${activeInstructions.length} active`);
  }
  if (instructionConflicts.length > 0) {
    const summary = instructionConflicts
      .map((conflict) => `${conflict.layer}${conflict.scope ? `:${conflict.scope}` : ''} (${conflict.ids.join(', ')})`)
      .join('; ');
    checks.push({
      name: 'instruction_conflicts',
      status: 'warn',
      message: `Multiple active instructions share the same layer/scope: ${summary}`,
    });
    if (!options.json) {
      console.warn(`⚠ Multiple active instructions share the same layer/scope: ${summary}`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'instruction_conflicts',
      status: 'ok',
      message: 'Instruction layers resolve without active scope conflicts',
    });
  }

  // --- Reflective memory checks ---
  const pending = listCandidates('pending', options.cwd);
  const accepted = listArchivedCandidates('accepted', options.cwd);
  const rejected = listArchivedCandidates('rejected', options.cwd);
  if (!options.json) {
    console.log('');
    console.log(`Reflective memory: ${pending.length} pending, ${accepted.length} accepted, ${rejected.length} rejected`);
  }

  // Governance checks
  const approvalPolicy = config.governance?.approval_policy ?? 'review';
  const curators = config.governance?.curators ?? [];
  if (approvalPolicy === 'strict' && curators.length === 0) {
    checks.push({ name: 'governance_config', status: 'warn', message: 'governance.approval_policy is strict but no governance.curators are configured.' });
    console.warn('⚠ governance.approval_policy is strict but no governance.curators are configured.');
    hasIssues = true;
  } else {
    checks.push({ name: 'governance_config', status: 'ok', message: `approval_policy=${approvalPolicy}, curators=${curators.length}` });
  }

  const maxPending = config.reflective_memory?.max_pending ?? 50;
  const promotionStarsThreshold = config.reflective_memory?.promotion_stars_threshold ?? 3;
  const promotionUsesThreshold = config.reflective_memory?.promotion_uses_threshold ?? 2;
  const reviewSlaHours = config.governance?.review_sla_hours ?? 24;
  const promotionReady = pending.filter((c) => (c.star_count ?? 0) >= promotionStarsThreshold || (c.usage_count ?? 0) >= promotionUsesThreshold);
  const pendingOverdue = pending.filter((c) => {
    const ageHours = Math.floor((Date.now() - Date.parse(c.created_at)) / (1000 * 60 * 60));
    return ageHours > reviewSlaHours;
  });

  const reviewed = [...accepted, ...rejected]
    .filter((c) => c.resolved_at)
    .map((c) => {
      const created = Date.parse(c.created_at);
      const resolved = Date.parse(c.resolved_at as string);
      return Math.max(0, resolved - created) / (1000 * 60 * 60);
    });
  const avgReviewHours = reviewed.length > 0
    ? reviewed.reduce((sum, value) => sum + value, 0) / reviewed.length
    : 0;

  if (!options.json) {
    console.log(`Governance review KPI: pending_overdue=${pendingOverdue.length}, avg_review_hours=${avgReviewHours.toFixed(1)}, review_sla_hours=${reviewSlaHours}`);
    console.log(`Promotion signal: ${promotionReady.length} candidate(s) reached ${promotionStarsThreshold} star(s) or ${promotionUsesThreshold} use(s)`);
  }

  if (promotionReady.length > 0) {
    checks.push({
      name: 'promotion_signals',
      status: 'warn',
      message: `${promotionReady.length} pending candidate(s) reached the promotion threshold (${promotionStarsThreshold} star(s) or ${promotionUsesThreshold} use(s)).`,
    });
    if (!options.json) {
      console.warn(`⚠ ${promotionReady.length} pending candidate(s) reached the promotion threshold (${promotionStarsThreshold} star(s) or ${promotionUsesThreshold} use(s)).`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'promotion_signals',
      status: 'ok',
      message: `No pending candidate reached the promotion threshold (${promotionStarsThreshold} star(s) or ${promotionUsesThreshold} use(s)).`,
    });
  }

  if (pendingOverdue.length > 0) {
    checks.push({ name: 'governance_sla', status: 'warn', message: `${pendingOverdue.length} pending candidate(s) are beyond review SLA (${reviewSlaHours}h).` });
    console.warn(`⚠ ${pendingOverdue.length} pending candidate(s) are beyond review SLA (${reviewSlaHours}h).`);
    hasIssues = true;
  } else {
    checks.push({ name: 'governance_sla', status: 'ok', message: `No pending candidate beyond SLA (${reviewSlaHours}h)` });
  }

  if (pending.length > maxPending) {
    checks.push({ name: 'pending_capacity', status: 'warn', message: `Too many pending candidates (${pending.length} > ${maxPending}).` });
    console.warn(`⚠ Too many pending candidates (${pending.length} > ${maxPending}). Consider reviewing or pruning.`);
    hasIssues = true;
  } else {
    checks.push({ name: 'pending_capacity', status: 'ok', message: `Pending candidates within limit (${pending.length}/${maxPending})` });
  }

  // Scan candidate texts for sensitive content
  const candidateWarnings: string[] = [];
  for (const c of pending) {
    const cw = scanText(c.text, config);
    for (const w of cw) {
      candidateWarnings.push(`${w.message} in candidate ${c.id}`);
    }
  }
  if (candidateWarnings.length > 0) {
    hasIssues = true;
    checks.push({ name: 'candidate_security', status: 'warn', message: `${candidateWarnings.length} warning(s) in pending candidates` });
    if (!options.json) {
      console.log('');
      console.log('Candidate warnings:');
    }
    for (const w of candidateWarnings) {
      if (!options.json) {
        console.warn(`  - ${w}`);
      }
    }
  } else if (pending.length > 0) {
    checks.push({ name: 'candidate_security', status: 'ok', message: 'No sensitive content detected in pending candidates' });
    if (!options.json) {
      console.log('✔ No sensitive content detected in pending candidates');
    }
  } else {
    checks.push({ name: 'candidate_security', status: 'ok', message: 'No pending candidates to scan' });
  }

  // Stale rejected candidates
  const pruneDays = config.reflective_memory?.prune_rejected_after_days ?? 30;
  const cutoff = new Date(Date.now() - pruneDays * 24 * 60 * 60 * 1000).toISOString();
  const staleRejected = rejected.filter(c => (c.resolved_at ?? c.created_at) < cutoff);
  if (staleRejected.length > 0) {
    checks.push({ name: 'rejected_cleanup', status: 'warn', message: `${staleRejected.length} rejected candidate(s) older than ${pruneDays} days.` });
    console.warn(`⚠ ${staleRejected.length} rejected candidate(s) older than ${pruneDays} days. Run \`brainclaw prune-candidates\` to clean up.`);
    hasIssues = true;
  } else {
    checks.push({ name: 'rejected_cleanup', status: 'ok', message: `No stale rejected candidates beyond ${pruneDays} days` });
  }

  // --- Contradiction detection ---
  try {
    const contradictions = detectContradictions(state);
    if (contradictions.length > 0) {
      hasIssues = true;
      checks.push({
        name: 'contradictions',
        status: 'warn',
        message: `${contradictions.length} potential contradiction(s) detected in state.`,
        details: contradictions.slice(0, 5).map((item) => ({
          item_id: item.item_id,
          conflicts_with: item.conflicts_with,
          section: item.section,
          kind: item.kind,
          severity: item.severity,
          score: item.score,
          reason: item.reason,
        })),
      });
      if (!options.json) {
        console.warn(`⚠ ${contradictions.length} potential contradiction(s) detected:`);
        for (const c of contradictions.slice(0, 5)) {
          console.warn(`  - [${c.item_id}] vs [${c.conflicts_with}] (${c.severity}, score ${c.score}): ${c.reason}`);
        }
      }
    } else {
      checks.push({ name: 'contradictions', status: 'ok', message: 'No contradictions detected in state' });
    }
  } catch (err) {
    logger.debug('Skipping contradictions check (module unavailable):', err);
  }

  // --- Expired items check ---
  const nowIso = new Date().toISOString();
  const expiredNotes = listRuntimeNotes(undefined, options.cwd).filter(n => n.expires_at && n.expires_at < nowIso);
  const expiredConstraints = state.active_constraints.filter(c => c.expires_at && c.expires_at < nowIso && c.status === 'active');
  const expiredTraps = state.known_traps.filter((t) => isTrapExpired(t, nowIso));
  const totalExpired = expiredNotes.length + expiredConstraints.length + expiredTraps.length;
  if (totalExpired > 0) {
    checks.push({ name: 'expired_items', status: 'warn', message: `${totalExpired} expired item(s): ${expiredConstraints.length} constraints, ${expiredNotes.length} notes, ${expiredTraps.length} traps. Run \`brainclaw prune --expired\` to clean up.` });
    if (!options.json) {
      console.warn(`⚠ ${totalExpired} expired item(s). Run \`brainclaw prune --expired\` to clean up.`);
    }
    hasIssues = true;
  } else {
    checks.push({ name: 'expired_items', status: 'ok', message: 'No expired items found' });
  }

  // --- Claims checks ---
  const claims = listClaims(options.cwd);
  const activeClaims = claims.filter(c => c.status === 'active');
  if (!options.json) {
    console.log('');
    console.log(`Claims: ${activeClaims.length} active, ${claims.length - activeClaims.length} released`);
  }

  // Check for duplicate scope claims
  const scopeCounts = new Map<string, string[]>();
  for (const c of activeClaims) {
    const list = scopeCounts.get(c.scope) ?? [];
    list.push(c.id);
    scopeCounts.set(c.scope, list);
  }
  for (const [scope, ids] of scopeCounts) {
    if (ids.length > 1) {
      checks.push({ name: 'claim_collisions', status: 'warn', message: `Multiple active claims on scope "${scope}": ${ids.join(', ')}` });
      console.warn(`⚠ Multiple active claims on scope "${scope}": ${ids.join(', ')}`);
      hasIssues = true;
    }
  }
  if (!checks.some((c) => c.name === 'claim_collisions')) {
    checks.push({ name: 'claim_collisions', status: 'ok', message: 'No overlapping active claims detected' });
  }

  // Warn if active claims have no linked plan
  const unlinkedClaims = activeClaims.filter((c) => !c.plan_id);
  if (unlinkedClaims.length > 0) {
    const ids = unlinkedClaims.map((c) => c.id).join(', ');
    checks.push({
      name: 'claim_plan_link',
      status: 'warn',
      message: `${unlinkedClaims.length} active claim(s) have no linked plan item: ${ids}. Pass planId when calling bclaw_claim to trace work to the backlog.`,
    });
    if (!options.json) {
      console.warn(`⚠ ${unlinkedClaims.length} active claim(s) have no linked plan item: ${ids}`);
      console.warn('  Pass planId when calling bclaw_claim to trace work to the backlog.');
    }
    hasIssues = true;
  } else if (activeClaims.length > 0) {
    checks.push({ name: 'claim_plan_link', status: 'ok', message: `All ${activeClaims.length} active claim(s) are linked to a plan item` });
    if (!options.json) {
      console.log(`✔ Claim plan links: all ${activeClaims.length} claim(s) linked`);
    }
  } else {
    checks.push({ name: 'claim_plan_link', status: 'ok', message: 'No active claims to check' });
  }

  // --- Runtime notes checks ---
  const notes = listRuntimeNotes(undefined, options.cwd);
  const localTraps = listOperationalTraps({}, options.cwd);
  if (!options.json) {
    console.log(`Runtime notes: ${notes.length} total`);
    console.log(`Local traps: ${localTraps.length} visible on this host`);
  }

  const marker = readContextMarker(options.cwd);
  const visibleMemoryVersion = getVisibleMemoryVersion({ cwd: options.cwd });
  if (marker?.memory_version && marker.memory_version !== visibleMemoryVersion) {
    checks.push({
      name: 'context_freshness',
      status: 'warn',
      message: `Last context read is stale for this host (marker ${marker.memory_version}, current ${visibleMemoryVersion}).`,
    });
    if (!options.json) {
      console.warn('⚠ Last context read is stale for this host. Run `brainclaw context` again before acting on old memory.');
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'context_freshness',
      status: 'ok',
      message: marker?.memory_version ? 'Last context marker matches current visible memory version' : 'No context marker found',
    });
    if (!options.json && marker?.memory_version) {
      console.log('✔ Context freshness marker matches current visible memory');
    }
  }

  // --- Runtime events integrity checks ---
  const events = listRuntimeEvents(options.cwd);
  if (events.length > 0) {
    const sessions = new Map<string, Set<string>>();
    for (const event of events) {
      const sessionValue = resolveEventSessionId(event);
      if (!sessionValue) continue;
      const set = sessions.get(sessionValue) ?? new Set<string>();
      set.add(event.event_type);
      sessions.set(sessionValue, set);
    }

    if (sessions.size > 0) {
      let incompleteSessions = 0;
      for (const [sessionId, eventTypes] of sessions.entries()) {
        if (!eventTypes.has('task_finished')) {
          incompleteSessions++;
          checks.push({ name: 'runtime_sessions', status: 'warn', message: `Runtime session '${sessionId}' has no task_finished event.` });
          console.warn(`⚠ Runtime session '${sessionId}' has no task_finished event.`);
          hasIssues = true;
        }
      }
      if (!options.json) {
        console.log(`Runtime events: ${events.length} total across ${sessions.size} session(s)`);
      }
      if (incompleteSessions === 0) {
        checks.push({ name: 'runtime_sessions', status: 'ok', message: 'Runtime sessions look consistent' });
        if (!options.json) {
          console.log('✔ Runtime sessions look consistent');
        }
      }
    } else {
      checks.push({ name: 'runtime_sessions', status: 'ok', message: `Runtime events: ${events.length} total (no session metadata)` });
      if (!options.json) {
        console.log(`Runtime events: ${events.length} total (no session metadata)`);
      }
    }
  } else {
    checks.push({ name: 'runtime_sessions', status: 'ok', message: 'No runtime events found' });
  }

  const metrics = {
    active_instructions: activeInstructions.length,
    active_plan_items: activePlans.length,
    blocked_plan_items: blockedPlans.length,
    promotion_ready_candidates: promotionReady.length,
    pending_candidates: pending.length,
    accepted_candidates: accepted.length,
    rejected_candidates: rejected.length,
    pending_overdue: pendingOverdue.length,
    avg_review_hours: Number(avgReviewHours.toFixed(1)),
    review_sla_hours: reviewSlaHours,
    active_claims: activeClaims.length,
    released_claims: claims.length - activeClaims.length,
    runtime_notes: notes.length,
    visible_local_traps: localTraps.length,
    memory_version: visibleMemoryVersion,
    stale_context: Boolean(marker?.memory_version && marker.memory_version !== visibleMemoryVersion),
    runtime_events: events.length,
    agent_rules: agentTooling.agents_rules.length,
    local_skills: agentTooling.skills.length,
    incomplete_skills: incompleteSkills.length,
    local_mcp_servers: agentTooling.mcp_servers.length,
    missing_mcp_commands: missingMcpCommands.length,
    agent_git_hygiene_present: agentGitHygiene.presentPaths.length,
    agent_git_hygiene_missing_ignore: agentGitHygiene.missingGitignorePaths.length,
    agent_git_hygiene_tracked: agentGitHygiene.trackedPaths.length,
    declared_agent_integrations: integrationReadiness.length,
    integration_activation_gaps: missingIntegrations.length,
    brainclaw_cli_version: brainclawVersion.cli_version,
    required_brainclaw_version: brainclawVersion.minimum_brainclaw_version,
    recommended_brainclaw_version: brainclawVersion.recommended_brainclaw_version,
  };

  const reputationSummary = buildReputationSummary(options.cwd);
  if (reputationSummary.enabled) {
    checks.push({
      name: 'reputation_summary',
      status: 'ok',
      message: `tracked_agents=${reputationSummary.tracked_agents}, avg_internal_trust=${reputationSummary.avg_internal_trust}`,
    });
    if (!options.json) {
      console.log(`Reputation: ${reputationSummary.tracked_agents} tracked agent(s), avg trust ${reputationSummary.avg_internal_trust}`);
    }
  }

  // Circuit-breaker health check
  const circuitSnapshot = buildCircuitBreakerSnapshot(options.cwd);
  if (circuitSnapshot.tripped_agents.length > 0) {
    const names = circuitSnapshot.tripped_agents.map(a => `${a.agent_key}(${a.rejection_count}/${a.threshold})`).join(', ');
    checks.push({
      name: 'circuit_breaker',
      status: 'warn',
      message: `${circuitSnapshot.tripped_agents.length} agent(s) in circuit-breaker: ${names}`,
      details: circuitSnapshot.tripped_agents,
    });
    hasIssues = true;
    if (!options.json) {
      console.warn(`⚠ Circuit-breaker: ${circuitSnapshot.tripped_agents.length} agent(s) suspended from auto-promote: ${names}`);
      console.warn(`  Use 'brainclaw set-trust <agent> --reset-breaker' to restore.`);
    }
  } else {
    checks.push({ name: 'circuit_breaker', status: 'ok', message: 'No agents in circuit-breaker' });
    if (!options.json) {
      console.log('✔ Circuit-breaker: no agents suspended');
    }
  }

  // --- Store hierarchy check ---
  try {
    const storeChain = resolveStoreChain(options.cwd ?? process.cwd());
    if (storeChain.length > 1) {
      const chainDesc = storeChain
        .map((s) => `${s.role}(d=${s.depth})`)
        .join(' → ');
      // Warn if multiple stores declare the same non-unknown role
      const roleCounts = new Map<string, number>();
      for (const s of storeChain) {
        if (s.role !== 'unknown') {
          roleCounts.set(s.role, (roleCounts.get(s.role) ?? 0) + 1);
        }
      }
      const duplicateRoles = [...roleCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([role]) => role);
      if (duplicateRoles.length > 0) {
        checks.push({
          name: 'store_hierarchy',
          status: 'warn',
          message: `Store hierarchy has duplicate roles: ${duplicateRoles.join(', ')}. Chain: ${chainDesc}`,
          details: storeChain,
        });
        if (!options.json) {
          console.warn(`⚠ Store hierarchy has duplicate roles (${duplicateRoles.join(', ')}): ${chainDesc}`);
        }
        hasIssues = true;
      } else {
        checks.push({
          name: 'store_hierarchy',
          status: 'ok',
          message: `Store chain (${storeChain.length} stores): ${chainDesc}`,
          details: storeChain,
        });
        if (!options.json) {
          console.log(`✔ Store chain (${storeChain.length}): ${chainDesc}`);
        }
      }
    } else {
      checks.push({
        name: 'store_hierarchy',
        status: 'ok',
        message: 'Single store — no parent stores found in hierarchy',
      });
    }
  } catch {
    // non-fatal
  }

  // Cross-project links validation
  try {
    const links = resolveCrossProjectLinks(options.cwd);
    if (links.length > 0) {
      const unavailable = links.filter((l) => !l.available);
      if (unavailable.length > 0) {
        hasIssues = true;
        const paths = unavailable.map((l) => l.path).join(', ');
        checks.push({ name: 'cross_project_links', status: 'error', message: `cross_project_links: ${unavailable.length} unreachable path(s): ${paths}` });
        if (!options.json) console.error(`✗ cross_project_links: ${unavailable.length} unreachable path(s): ${paths}`);
      } else {
        checks.push({ name: 'cross_project_links', status: 'ok', message: `cross_project_links: ${links.length} link(s) OK` });
        if (!options.json) console.log(`✔ cross_project_links: ${links.length} link(s) OK`);
      }
      const cycles = detectCrossProjectCycles(options.cwd);
      if (cycles.length > 0) {
        hasIssues = true;
        checks.push({ name: 'cross_project_cycles', status: 'error', message: `cross_project_links cycle detected: ${cycles[0].join(' → ')}` });
        if (!options.json) console.error(`✗ cross_project_links cycle: ${cycles[0].join(' → ')}`);
      }
    }
  } catch {
    // non-fatal
  }

  // --- Backlog patterns in open handoffs ---
  try {
    const openHandoffs = state.open_handoffs.filter((h) => h.status === 'open');
    const handoffsWithBacklog = openHandoffs.filter((h) => !h.plan_id && hasBacklogPatterns(h.text));
    if (handoffsWithBacklog.length > 0) {
      const ids = handoffsWithBacklog.map((h) => h.id).join(', ');
      checks.push({
        name: 'handoff_backlog',
        status: 'warn',
        message: `${handoffsWithBacklog.length} open handoff(s) contain backlog patterns without a linked plan: ${ids}. Run \`brainclaw plan create "<text>"\` to formalize.`,
        details: handoffsWithBacklog.map((h) => ({ id: h.id, from: h.from, to: h.to })),
      });
      if (!options.json) {
        console.warn(`⚠ ${handoffsWithBacklog.length} open handoff(s) contain unformalized backlog (no plan linked): ${ids}`);
        console.warn('  Run `brainclaw plan create "<description>"` to create formal plan items.');
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'handoff_backlog',
        status: 'ok',
        message: openHandoffs.length > 0
          ? `${openHandoffs.length} open handoff(s) checked — no unformalized backlog detected`
          : 'No open handoffs to check',
      });
      if (!options.json && openHandoffs.length > 0) {
        console.log(`✔ Handoff backlog: ${openHandoffs.length} open handoff(s) checked, all covered`);
      }
    }

    // Check scope hygiene - warn if machine-level items are at project level
    try {
      const MACHINE_TAGS = ['windows', 'wsl', 'powershell', 'ssh', 'linux', 'macos', 'env', 'path', 'node-path'];
      const chain = resolveStoreChain(options.cwd);
      const userStoreExists = chain.some((s) => s.role === 'user');

      if (userStoreExists) {
        const projectState = loadState(options.cwd);
        const projectLevelItems: Array<{ id: string; type: string; text: string; tags: string[] }> = [];

        // Collect project-level items with machine-generic tags
        for (const constraint of projectState.active_constraints) {
          const hasMachineTag = constraint.tags.some((t) => MACHINE_TAGS.includes(t.toLowerCase()));
          if (hasMachineTag) projectLevelItems.push({ id: constraint.id, type: 'constraint', text: constraint.text, tags: constraint.tags });
        }
        for (const decision of projectState.recent_decisions) {
          const hasMachineTag = decision.tags.some((t) => MACHINE_TAGS.includes(t.toLowerCase()));
          if (hasMachineTag) projectLevelItems.push({ id: decision.id, type: 'decision', text: decision.text, tags: decision.tags });
        }
        for (const trap of projectState.known_traps) {
          const hasMachineTag = trap.tags.some((t) => MACHINE_TAGS.includes(t.toLowerCase()));
          if (hasMachineTag) projectLevelItems.push({ id: trap.id, type: 'trap', text: trap.text, tags: trap.tags });
        }

        if (projectLevelItems.length > 0) {
          const itemDescr = projectLevelItems.map((i) => `${i.type}[${i.id.slice(0, 8)}]`).join(', ');
          checks.push({
            name: 'scope_hygiene',
            status: 'warn',
            message: `${projectLevelItems.length} project-level item(s) have machine-generic tags: ${itemDescr}. Consider moving to user store.`,
            details: projectLevelItems,
          });
          if (!options.json) {
            console.warn(`⚠ Scope hygiene: ${projectLevelItems.length} project-level item(s) with machine tags (windows, wsl, ssh, etc.) should be in user store`);
            projectLevelItems.forEach((item) => {
              console.warn(`  - [${item.id.slice(0, 8)}] ${item.type}: tags=[${item.tags.join(', ')}]`);
            });
          }
        } else {
          checks.push({ name: 'scope_hygiene', status: 'ok', message: 'No machine-level items detected at project scope' });
          if (!options.json) {
            console.log('✔ Scope hygiene: no machine-level items at project scope');
          }
        }
      } else {
        checks.push({ name: 'scope_hygiene', status: 'ok', message: 'User store not configured (scope hygiene skipped)' });
      }
    } catch { /* non-fatal */ }

    // Check for cross-level duplicates
    try {
      const chain = resolveStoreChain(options.cwd);
      const allConstraints: Map<string, Array<{ id: string; store: string; text: string }>> = new Map();
      const allDecisions: Map<string, Array<{ id: string; store: string; text: string }>> = new Map();
      const allTraps: Map<string, Array<{ id: string; store: string; text: string }>> = new Map();

      // Collect items from all stores
      for (const store of chain) {
        try {
          const storeState = loadState(store.cwd);
          const storeName = store.role;

          for (const constraint of storeState.active_constraints) {
            const key = constraint.text.slice(0, 60).toLowerCase();
            if (!allConstraints.has(key)) allConstraints.set(key, []);
            allConstraints.get(key)!.push({ id: constraint.id, store: storeName, text: constraint.text });
          }
          for (const decision of storeState.recent_decisions) {
            const key = decision.text.slice(0, 60).toLowerCase();
            if (!allDecisions.has(key)) allDecisions.set(key, []);
            allDecisions.get(key)!.push({ id: decision.id, store: storeName, text: decision.text });
          }
          for (const trap of storeState.known_traps) {
            const key = trap.text.slice(0, 60).toLowerCase();
            if (!allTraps.has(key)) allTraps.set(key, []);
            allTraps.get(key)!.push({ id: trap.id, store: storeName, text: trap.text });
          }
        } catch { /* skip stores that can't be read */ }
      }

      // Find duplicates (same text at different levels)
      const duplicates: Array<{ type: string; text: string; items: Array<{ id: string; store: string }> }> = [];

      allConstraints.forEach((items, key) => {
        if (items.length > 1 && new Set(items.map((i) => i.store)).size > 1) {
          duplicates.push({
            type: 'constraint',
            text: items[0].text,
            items: items.map((i) => ({ id: i.id, store: i.store })),
          });
        }
      });
      allDecisions.forEach((items, key) => {
        if (items.length > 1 && new Set(items.map((i) => i.store)).size > 1) {
          duplicates.push({
            type: 'decision',
            text: items[0].text,
            items: items.map((i) => ({ id: i.id, store: i.store })),
          });
        }
      });
      allTraps.forEach((items, key) => {
        if (items.length > 1 && new Set(items.map((i) => i.store)).size > 1) {
          duplicates.push({
            type: 'trap',
            text: items[0].text,
            items: items.map((i) => ({ id: i.id, store: i.store })),
          });
        }
      });

      if (duplicates.length > 0) {
        checks.push({
          name: 'cross_level_duplicates',
          status: 'warn',
          message: `${duplicates.length} potential duplicate(s) detected across store levels. Review and deduplicate if needed.`,
          details: duplicates.slice(0, 10), // Limit to 10 for brevity
        });
        if (!options.json) {
          console.warn(`⚠ Cross-level duplicates: ${duplicates.length} potential duplicate(s) across store levels`);
          duplicates.slice(0, 10).forEach((dup) => {
            console.warn(`  - ${dup.type}: "${dup.text.slice(0, 40)}..." at [${dup.items.map((i) => i.store).join(', ')}]`);
          });
        }
      } else {
        checks.push({ name: 'cross_level_duplicates', status: 'ok', message: 'No cross-level duplicates detected' });
        if (!options.json) {
          console.log('✔ Cross-level duplicates: no duplicates across store levels');
        }
      }

      // Metadata consistency checks
      const capabilities = state.recent_decisions.filter((d) => d.tags.includes('capability'));
      const tools = state.recent_decisions.filter((d) => d.tags.includes('tool'));
      const metadataIssues: string[] = [];

      // Check capabilities completeness
      capabilities.forEach((cap) => {
        const category = cap.tags.find((t) => t !== 'capability');
        if (!category) {
          metadataIssues.push(`Capability [${cap.id}] missing category`);
        }
        if (!cap.text || cap.text.trim().length === 0) {
          metadataIssues.push(`Capability [${cap.id}] has empty description`);
        }
      });

      // Check tools completeness
      tools.forEach((tool) => {
        const type = tool.tags.find((t) => t !== 'tool');
        if (!type) {
          metadataIssues.push(`Tool [${tool.id}] missing type`);
        }
        if (!tool.text || tool.text.trim().length === 0) {
          metadataIssues.push(`Tool [${tool.id}] has empty description`);
        }
      });

      if (metadataIssues.length > 0) {
        checks.push({
          name: 'metadata_consistency',
          status: 'warn',
          message: `${metadataIssues.length} metadata inconsistency(ies) found. Capabilities/tools may be incomplete.`,
          details: metadataIssues.slice(0, 10),
        });
        if (!options.json) {
          console.warn(`⚠ Metadata consistency: ${metadataIssues.length} issue(s) found`);
          metadataIssues.slice(0, 10).forEach((issue) => {
            console.warn(`  - ${issue}`);
          });
        }
      } else {
        checks.push({
          name: 'metadata_consistency',
          status: 'ok',
          message: `Metadata consistency OK (${capabilities.length} capabilities, ${tools.length} tools)`,
        });
        if (!options.json) {
          console.log(`✔ Metadata consistency: ${capabilities.length} capabilities, ${tools.length} tools registered`);
        }
      }
    } catch { /* non-fatal */ }
  } catch { /* non-fatal */ }

  if (options.json) {
    console.log(JSON.stringify({
      ok: !hasIssues,
      checks,
      metrics: {
        ...metrics,
        migration_outdated_documents: migrationEntries.filter((entry) => entry.status === 'outdated').length,
        migration_invalid_documents: migrationEntries.filter((entry) => entry.status === 'invalid').length,
        reputation_enabled: reputationSummary.enabled,
        reputation_tracked_agents: reputationSummary.tracked_agents,
        reputation_avg_internal_trust: reputationSummary.avg_internal_trust,
        reputation_current_agent_trust: reputationSummary.current_agent_trust ?? 0,
        circuit_breaker_tripped_count: circuitSnapshot.tripped_agents.length,
        circuit_breaker_threshold: circuitSnapshot.threshold,
        circuit_breaker_window_days: circuitSnapshot.window_days,
        agent_git_hygiene_fixed: agentGitHygieneFixed.length,
      },
      migration: options.migrationCheck
        ? {
            entries: migrationEntries,
            outdated: migrationEntries.filter((entry) => entry.status === 'outdated').length,
            invalid: migrationEntries.filter((entry) => entry.status === 'invalid').length,
          }
        : undefined,
    }, null, 2));
    return;
  }

  if (!hasIssues) {
    console.log('');
    console.log('All checks passed.');
  }
}
