import { ConfigSchema, type Config, type IgnoreStrategy, type ProjectMode, type ProjectStrategy, type TopologyMode } from './schema.js';
import { memoryPath } from './io.js';
import { loadVersionedYamlFile, saveVersionedYamlFile } from './migration.js';

const CONFIG_FILE = 'config.yaml';

export interface DefaultConfigOptions {
  projectId?: string;
  currentAgent?: string;
  currentAgentId?: string;
  projectMode?: ProjectMode;
  projectStrategy?: ProjectStrategy;
  storageDir?: string;
  topology?: TopologyMode;
  ignoreStrategy?: IgnoreStrategy;
  /**
   * Seed governance.curators with this name. Used by `init` on a fresh
   * project so the human running init becomes the default curator —
   * otherwise approval_policy=review + curators=[] traps every note in
   * pending forever (a solo-agent surprise documented in the 2026-06-10
   * front-door analysis).
   */
  curatorName?: string;
}

export function defaultConfig(projectName: string, options: DefaultConfigOptions = {}): Config {
  return {
    schema_version: 2,
    version: 1,
    project_name: projectName,
    project_id: options.projectId,
    current_agent: options.currentAgent,
    current_agent_id: options.currentAgentId,
    storage_dir: options.storageDir ?? '.brainclaw',
    topology: options.topology ?? 'embedded',
    ignore_strategy: options.ignoreStrategy ?? 'none',
    project_mode: options.projectMode ?? 'auto',
    projects: {
      strategy: options.projectStrategy ?? 'manual',
      known: [],
    },
    profile: 'dev',
    target_audience: 'human',
    openclaw_bridge: false,
    telemetry: false,
    allow_network: false,
    redaction: {
      enabled: true,
      patterns: [
        '(?i)api[_-]?key',
        '(?i)secret',
        '(?i)token',
        '(?i)password',
      ],
    },
    sensitive_paths: ['.env', 'secrets/', '.git/', 'node_modules/'],
    security: {
      mode: 'warn',
      strict_redaction: false,
      block_sensitive_paths: true,
      token_detection: {
        enabled: true,
        entropy: { enabled: true, min_length: 32, min_entropy: 4.0 },
        detectors: {},
      },
    },
    markdown: {
      max_items_per_section: 20,
      compact_mode: false,
    },
    reflective_memory: {
      enabled: true,
      auto_accept: false,
      max_pending: 50,
      promotion_stars_threshold: 3,
      promotion_uses_threshold: 2,
      prune_rejected_after_days: 30,
      auto_promote_trusted: false,
      auto_promote_score_threshold: 5,
      circuit_breaker_threshold: 5,
      circuit_breaker_window_days: 7,
    },
    governance: {
      approval_policy: 'review',
      curators: options.curatorName ? [options.curatorName] : [],
      review_sla_hours: 24,
    },
    reputation: {
      enabled: false,
      visibility: 'internal-only',
      decay_days: 30,
      ranking_weight: 0.15,
      resume_weight: 0.35,
      mcp_exposure: false,
    },
    agent_integrations: {
      declarations: [],
    },
    cross_project_links: [],
    implicit_session_ttl: '4h',
    auto_reflect_notes: false,
    auto_refresh_live: true,
    claims: {
      auto_release_after_hours: 24,
    },
  };
}

export function loadConfig(cwd?: string, preferredDirName?: string): Config {
  const filepath = memoryPath(CONFIG_FILE, cwd, preferredDirName);
  return loadVersionedYamlFile<Config>('config', filepath).document;
}

export function saveConfig(config: Config, cwd?: string, preferredDirName?: string): void {
  const filepath = memoryPath(CONFIG_FILE, cwd, preferredDirName);
  saveVersionedYamlFile('config', filepath, ConfigSchema.parse(config));
}
