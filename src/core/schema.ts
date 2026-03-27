import { z } from 'zod';

// --- Helpers ---

/** Coerce legacy effort strings ("30min", "2h", "1d") to integer minutes for migration.
 *  Already-numeric values pass through unchanged. Unparseable strings → undefined. */
function coerceEffortToMinutes(val: unknown): unknown {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    let total = 0, matched = false;
    const d = s.match(/(\d+(?:\.\d+)?)\s*d/); if (d) { total += parseFloat(d[1]!) * 8 * 60; matched = true; }
    const h = s.match(/(\d+(?:\.\d+)?)\s*h/); if (h) { total += parseFloat(h[1]!) * 60; matched = true; }
    const m = s.match(/(\d+(?:\.\d+)?)\s*m(?:in)?/); if (m) { total += parseFloat(m[1]!); matched = true; }
    if (!matched) { const bare = parseFloat(s); if (!isNaN(bare) && bare > 0 && /^\d+(\.\d+)?$/.test(s)) return Math.round(bare); return undefined; }
    return total > 0 ? Math.round(total) : undefined;
  }
  return undefined;
}

/** Coerce tags from JSON string to array when MCP clients serialize arrays as strings.
 *  Accepts: string[] (passthrough), '["a","b"]' (JSON parse), 'a,b' (comma split). */
function coerceTags(val: unknown): unknown {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('[')) {
      try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed; } catch { /* fall through */ }
    }
    if (trimmed.length > 0) return trimmed.split(',').map(t => t.trim()).filter(Boolean);
    return [];
  }
  return val;
}

/** Resilient tags schema that accepts string[] or JSON-serialized string. */
export const TagsSchema = z.preprocess(coerceTags, z.array(z.string()));
export const TagsWithDefaultSchema = z.preprocess(coerceTags, z.array(z.string()).default([]));

// --- Entry schemas ---

export const ConstraintStatusSchema = z.enum(['active', 'resolved', 'expired']);
export type ConstraintStatus = z.infer<typeof ConstraintStatusSchema>;

export const ConstraintCategorySchema = z.enum(['architecture', 'performance', 'security', 'reliability', 'compatibility', 'process', 'other']);
export type ConstraintCategory = z.infer<typeof ConstraintCategorySchema>;

export const SeveritySchema = z.enum(['low', 'medium', 'high']);
export type Severity = z.infer<typeof SeveritySchema>;

export const TrapStatusSchema = z.enum(['active', 'resolved', 'expired']);
export type TrapStatus = z.infer<typeof TrapStatusSchema>;

export const PrioritySchema = z.enum(['low', 'medium', 'high']);
export type Priority = z.infer<typeof PrioritySchema>;

export const MemoryVisibilitySchema = z.enum(['shared', 'machine', 'private']);
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;

export const HandoffStatusSchema = z.enum(['open', 'accepted', 'closed']);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const DecisionOutcomeSchema = z.enum(['approved', 'rejected', 'deferred', 'pending']);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

export const MemoryScopeSchema = z.enum(['project', 'machine', 'user']).default('project');
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const ConstraintSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  short_label: z.string().optional(),
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  model: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  status: ConstraintStatusSchema,
  category: ConstraintCategorySchema.optional(),
  scope: MemoryScopeSchema.optional(),
  tags: TagsSchema,
  related_paths: z.array(z.string()).optional(),
  expires_at: z.string().optional(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const DecisionSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  short_label: z.string().optional(),
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  model: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  outcome: DecisionOutcomeSchema.optional(),
  scope: MemoryScopeSchema.optional(),
  related_paths: z.array(z.string()).optional(),
  plan_id: z.string().optional(),
  tags: TagsSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const TrapSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  short_label: z.string().optional(),
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  model: z.string().optional(),
  project_id: z.string().optional(),
  session_id: z.string().optional(),
  status: TrapStatusSchema.default('active'),
  severity: SeveritySchema,
  scope: MemoryScopeSchema.optional(),
  tags: TagsSchema,
  related_paths: z.array(z.string()).optional(),
  plan_id: z.string().optional(),
  visibility: MemoryVisibilitySchema.default('shared'),
  host_id: z.string().optional(),
  expires_at: z.string().optional(),
  platform_scope: z.string().optional(),
});
export type Trap = z.infer<typeof TrapSchema>;

export const HandoffContractSchema = z.object({
  files_touched: z.array(z.string()).optional(),
  pre_conditions: z.array(z.string()).optional(),
  post_conditions: z.array(z.string()).optional(),
  tests_to_verify: z.array(z.string()).optional(),
  linked_plans: z.array(z.string()).optional(),
});
export type HandoffContract = z.infer<typeof HandoffContractSchema>;

export const HandoffSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  short_label: z.string().optional(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  model: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  status: HandoffStatusSchema,
  project: z.string().optional(),
  plan_id: z.string().optional(),
  tags: TagsSchema,
  related_paths: z.array(z.string()).optional(),
  contract: HandoffContractSchema.optional(),
  snapshot: z.object({
    diff: z.string().optional(),
  }).optional(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const PlanStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done', 'dropped']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanStepStatusSchema = z.enum(['todo', 'in_progress', 'testing', 'done', 'blocked']);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const PlanStepSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: PlanStepStatusSchema.default('todo'),
  assignee: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanTypeSchema = z.enum(['feat', 'fix', 'chore', 'spike', 'doc']).default('feat');
export type PlanType = z.infer<typeof PlanTypeSchema>;

export const PlanItemSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  short_label: z.string().optional(),
  text: z.string(),
  type: PlanTypeSchema.optional(),
  created_at: z.string(),
  updated_at: z.string(),
  author: z.string(),
  model: z.string().optional(),
  status: PlanStatusSchema,
  priority: PrioritySchema,
  assignee: z.string().optional(),
  project: z.string().optional(),
  tags: TagsSchema,
  related_paths: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).default([]),
  steps: z.array(PlanStepSchema).optional(),
  estimated_effort: z.preprocess(coerceEffortToMinutes, z.number().int().positive().optional()),
  actual_effort: z.string().optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const InstructionLayerSchema = z.enum(['global', 'project', 'agent']);
export type InstructionLayer = z.infer<typeof InstructionLayerSchema>;

export const InstructionEntrySchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  layer: InstructionLayerSchema,
  scope: z.string().optional(),
  text: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  author: z.string(),
  model: z.string().optional(),
  tags: TagsWithDefaultSchema,
  active: z.boolean().default(true),
  supersedes: z.string().optional(),
});
export type InstructionEntry = z.infer<typeof InstructionEntrySchema>;

export const CapabilityStatusSchema = z.enum(['stable', 'experimental', 'deprecated']);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const ProjectCapabilitySchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(), // e.g. "auth", "api", "storage", "testing"
  provided_by: z.string().optional(), // path to implementation
  requires: z.array(z.string()).optional(), // capability IDs this depends on
  tags: TagsSchema,
  example_usage: z.string().optional(),
  status: CapabilityStatusSchema.default('stable'),
  related_paths: z.array(z.string()).optional(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  model: z.string().optional(),
});
export type ProjectCapability = z.infer<typeof ProjectCapabilitySchema>;

export const ToolTypeSchema = z.enum(['workflow', 'validator', 'generator', 'utility', 'explorer']);
export type ToolType = z.infer<typeof ToolTypeSchema>;

export const ProjectToolSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: ToolTypeSchema,
  implementation: z.string(), // path or command
  mcp_name: z.string().optional(), // if exposed as MCP tool
  cli_command: z.string().optional(), // if exposed as CLI command
  requires: z.array(z.string()).optional(), // tool IDs this depends on
  suggests_for: z.array(z.string()).optional(), // agent types or domains
  invocation_example: z.string().optional(),
  tags: TagsSchema,
  status: CapabilityStatusSchema.default('stable'),
  related_paths: z.array(z.string()).optional(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  model: z.string().optional(),
});
export type ProjectTool = z.infer<typeof ProjectToolSchema>;

// --- State schema ---

export const StateSchema = z.object({
  version: z.literal(1),
  write_version: z.number().default(1),
  active_constraints: z.array(ConstraintSchema),
  recent_decisions: z.array(DecisionSchema),
  known_traps: z.array(TrapSchema),
  open_handoffs: z.array(HandoffSchema),
  plan_items: z.array(PlanItemSchema).default([]),
});
export type State = z.infer<typeof StateSchema>;

// --- Config schema ---

export const RedactionConfigSchema = z.object({
  enabled: z.boolean(),
  patterns: z.array(z.string()),
});

export const SecurityConfigSchema = z.object({
  mode: z.enum(['warn', 'strict']).default('warn'),
  strict_redaction: z.boolean().default(false),
  block_sensitive_paths: z.boolean().default(true),
});

export const MarkdownConfigSchema = z.object({
  max_items_per_section: z.number().default(20),
  compact_mode: z.boolean().default(false),
});

// --- Reflective memory schemas ---

export const CandidateTypeSchema = z.enum([
  'constraint', 'decision', 'trap', 'handoff',
]);
export type CandidateType = z.infer<typeof CandidateTypeSchema>;

export const CandidateStatusSchema = z.enum(['pending', 'accepted', 'rejected']);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

export const CandidateUseSchema = z.object({
  by: z.string(),
  context: z.string(),
  created_at: z.string(),
});
export type CandidateUse = z.infer<typeof CandidateUseSchema>;

export const ContradictionSeveritySchema = z.enum(['low', 'medium', 'high']);
export type ContradictionSeverity = z.infer<typeof ContradictionSeveritySchema>;

export const CandidateContradictionSchema = z.object({
  item_id: z.string(),
  conflicts_with: z.string(),
  reason: z.string(),
  section: z.string(),
  severity: ContradictionSeveritySchema,
  score: z.number(),
  kind: z.string(),
});
export type CandidateContradiction = z.infer<typeof CandidateContradictionSchema>;

export const CandidateSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  short_label: z.string().optional(),
  type: CandidateTypeSchema,
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  model: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  source: z.string().optional(),
  tags: TagsSchema,
  status: CandidateStatusSchema,
  // type-specific optional fields
  severity: SeveritySchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  related_paths: z.array(z.string()).optional(),
  star_count: z.number().default(0),
  starred_by: z.array(z.string()).default([]),
  last_starred_at: z.string().optional(),
  usage_count: z.number().default(0),
  usage_events: z.array(CandidateUseSchema).default([]),
  last_used_at: z.string().optional(),
  plan_id: z.string().optional(),
  contradictions_detected: z.array(CandidateContradictionSchema).optional(),
  contradiction_summary: z.string().optional(),
  promotion_blocked_reason: z.string().optional(),
  resolved_at: z.string().optional(),
  resolved_by: z.string().optional(),
  resolution_reason: z.string().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const ReflectiveMemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  auto_accept: z.boolean().default(false),
  max_pending: z.number().default(50),
  promotion_stars_threshold: z.number().default(3),
  promotion_uses_threshold: z.number().default(2),
  prune_rejected_after_days: z.number().default(30),
  auto_promote_trusted: z.boolean().default(false),
  auto_promote_score_threshold: z.number().default(5),
  circuit_breaker_threshold: z.number().int().positive().default(5),
  circuit_breaker_window_days: z.number().int().positive().default(7),
});

export const GovernanceConfigSchema = z.object({
  approval_policy: z.enum(['none', 'review', 'strict']).default('review'),
  curators: z.array(z.string()).default([]),
  review_sla_hours: z.number().default(24),
});

export const ReputationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  visibility: z.enum(['internal-only', 'summary', 'full']).default('internal-only'),
  decay_days: z.number().default(30),
  ranking_weight: z.number().default(0.15),
  resume_weight: z.number().default(0.35),
  mcp_exposure: z.boolean().default(false),
});
export type ReputationConfig = z.infer<typeof ReputationConfigSchema>;

// --- Work claims schemas ---

export const ClaimStatusSchema = z.enum(['active', 'released', 'stale']);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const ClaimSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  agent: z.string(),
  agent_id: z.string().optional(),
  /** OS user who created this claim. */
  user: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  scope: z.string(),
  description: z.string(),
  created_at: z.string(),
  project: z.string().optional(),
  plan_id: z.string().optional(),
  status: ClaimStatusSchema,
  released_at: z.string().optional(),
  expires_at: z.string().optional(),
  model: z.string().optional(),
  /** Absolute path to the git worktree associated with this claim, if one was created. */
  worktree_path: z.string().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

// --- Runtime notes schemas ---

export const RuntimeNoteSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  agent: z.string(),
  agent_id: z.string().optional(),
  project_id: z.string().optional(),
  session_id: z.string().optional(),
  text: z.string(),
  created_at: z.string(),
  project: z.string().optional(),
  plan_id: z.string().optional(),
  tags: TagsSchema,
  visibility: MemoryVisibilitySchema.default('shared'),
  host_id: z.string().optional(),
  expires_at: z.string().optional(),
  note_type: z.enum(['observation', 'session_start', 'session_end']).default('observation'),
  model: z.string().optional(),
});
export type RuntimeNote = z.infer<typeof RuntimeNoteSchema>;

// --- AI surface task request schemas ---

export const AiSurfaceTaskStatusSchema = z.enum(['queued', 'in_progress', 'completed', 'cancelled', 'failed']);
export type AiSurfaceTaskStatus = z.infer<typeof AiSurfaceTaskStatusSchema>;

export const AiSurfaceTaskKindSchema = z.enum(['visual_asset', 'draft', 'summary', 'analysis', 'research', 'custom']);
export type AiSurfaceTaskKind = z.infer<typeof AiSurfaceTaskKindSchema>;

export const AiSurfaceTaskRequestSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  short_label: z.string().optional(),
  title: z.string(),
  instructions: z.string(),
  target_surface: z.string(),
  kind: AiSurfaceTaskKindSchema.default('custom'),
  created_at: z.string(),
  updated_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  project_id: z.string().optional(),
  session_id: z.string().optional(),
  status: AiSurfaceTaskStatusSchema.default('queued'),
  requested_outputs: z.array(z.string()).default([]),
  related_paths: z.array(z.string()).optional(),
  tags: TagsWithDefaultSchema,
  claimed_at: z.string().optional(),
  completed_at: z.string().optional(),
  result_note: z.string().optional(),
  model: z.string().optional(),
});
export type AiSurfaceTaskRequest = z.infer<typeof AiSurfaceTaskRequestSchema>;

// --- Runtime event schemas ---

export const RuntimeEventTypeSchema = z.enum([
  'task_started',
  'observation',
  'risk_detected',
  'handoff_requested',
  'task_finished',
  'session_start',
  'session_end',
]);
export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>;

export const RuntimeEventSchema = z.object({
  id: z.string(),
  agent: z.string(),
  agent_id: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  event_type: RuntimeEventTypeSchema,
  created_at: z.string(),
  text: z.string(),
  tags: TagsWithDefaultSchema,
  // Optional routing and type hints for candidate generation
  candidate_type: CandidateTypeSchema.optional(),
  severity: SeveritySchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  related_paths: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  model: z.string().optional(),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

// --- Profile schema ---

export const ProfileSchema = z.enum(['dev', 'openclaw', 'ops', 'research']);
export type Profile = z.infer<typeof ProfileSchema>;

export const ProjectModeSchema = z.enum(['single-project', 'multi-project', 'auto']);
export type ProjectMode = z.infer<typeof ProjectModeSchema>;

export const ProjectStrategySchema = z.enum(['manual', 'folder']);
export type ProjectStrategy = z.infer<typeof ProjectStrategySchema>;

export const TopologyModeSchema = z.enum(['embedded', 'sidecar', 'local-only']);
export type TopologyMode = z.infer<typeof TopologyModeSchema>;

export const IgnoreStrategySchema = z.enum(['project-gitignore', 'none']);
export type IgnoreStrategy = z.infer<typeof IgnoreStrategySchema>;

export const AgentKindSchema = z.enum(['agent', 'autonomous', 'human', 'unknown']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AgentTrustLevelSchema = z.enum(['observer', 'contributor', 'trusted', 'curator']);
export type AgentTrustLevel = z.infer<typeof AgentTrustLevelSchema>;

export const AgentIdentityKeySchema = z.object({
  algorithm: z.literal('ed25519'),
  public_key: z.string(),
  fingerprint: z.string(),
  created_at: z.string(),
});
export type AgentIdentityKey = z.infer<typeof AgentIdentityKeySchema>;

export const ProjectIdentityDocumentSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  version: z.literal(1),
  project_id: z.string(),
  project_name: z.string(),
  created_at: z.string(),
  storage_dir: z.string(),
  topology: TopologyModeSchema,
});
export type ProjectIdentityDocument = z.infer<typeof ProjectIdentityDocumentSchema>;

export const AgentIdentityDocumentSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  version: z.literal(1),
  agent_id: z.string(),
  agent_name: z.string(),
  created_at: z.string(),
  kind: AgentKindSchema.default('unknown'),
  trust_level: AgentTrustLevelSchema.default('contributor'),
  capabilities: z.array(z.string()).default([]),
  identity_key: AgentIdentityKeySchema.optional(),
  model: z.string().optional(),
});
export type AgentIdentityDocument = z.infer<typeof AgentIdentityDocumentSchema>;

export const ProjectsConfigSchema = z.object({
  strategy: ProjectStrategySchema.default('manual'),
  known: z.array(z.string()).default([]),
});
export type ProjectsConfig = z.infer<typeof ProjectsConfigSchema>;

export const RemoteSyncSchema = z.object({
  url: z.string(),
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'other']).optional(),
  ssh_key_path: z.string().optional(),
  sync_strategy: z.enum(['pull-only', 'push-pull', 'pr-based']).default('push-pull'),
});
export type RemoteSync = z.infer<typeof RemoteSyncSchema>;

export const SessionSnapshotSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  session_id: z.string(),
  agent: z.string(),
  agent_id: z.string().optional(),
  model: z.string().optional(),
  started_at: z.string(),
  context_target: z.string().optional(),
  initial_context_hash: z.string().optional(),
  git_sha: z.string().optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export const SessionActiveProjectSchema = z.object({
  /** Absolute path to the project directory. */
  path: z.string(),
  /** Project name from config.yaml (when available). */
  name: z.string().optional(),
  /** ISO timestamp of the switch. */
  switched_at: z.string(),
}).strict();
export type SessionActiveProject = z.infer<typeof SessionActiveProjectSchema>;

export const IsolationModeSchema = z.enum(['shared-checkout', 'dedicated-worktree']);
export type IsolationMode = z.infer<typeof IsolationModeSchema>;

export const CurrentSessionStateSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  session_id: z.string(),
  started_at: z.string(),
  last_seen_at: z.string(),
  agent: z.string(),
  agent_id: z.string(),
  host_id: z.string(),
  /** OS user who started this session. */
  user: z.string().optional(),
  /** Process ID of the agent process (for liveness detection). */
  pid: z.number().int().positive().optional(),
  /** LLM model used in this session (e.g. "claude-opus-4-6", "gpt-4.1"). */
  model: z.string().optional(),
  /** Session-scoped active project (overrides global active-project.json). */
  active_project: SessionActiveProjectSchema.optional(),
  /** Git worktree path for this session (undefined = main worktree / shared checkout). */
  worktree_path: z.string().optional(),
  /** Git branch this session is working on. */
  branch: z.string().optional(),
  /** Isolation mode: shared-checkout (default) or dedicated-worktree. */
  isolation_mode: IsolationModeSchema.optional(),
});
export type CurrentSessionState = z.infer<typeof CurrentSessionStateSchema>;

export const MemorySeedKindSchema = z.enum([
  'command',
  'convention',
  'entrypoint',
  'hotspot',
  'agent_rule',
  'warning',
  'environment',
  'tooling',
]);
export type MemorySeedKind = z.infer<typeof MemorySeedKindSchema>;

export const MemorySeedSourceKindSchema = z.enum([
  'readme',
  'agents_md',
  'native_instruction',
  'manifest',
  'repo_analysis',
  'git',
  'inference',
  'machine',
  'skill',
  'mcp',
  'ci_config',
  'contributing',
  'changelog',
  'docker',
  'env_example',
  'adr',
]);
export type MemorySeedSourceKind = z.infer<typeof MemorySeedSourceKindSchema>;

export const MemorySeedConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type MemorySeedConfidence = z.infer<typeof MemorySeedConfidenceSchema>;

export const MemorySeedDocumentSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  derived_at: z.string(),
  text: z.string(),
  seed_kind: MemorySeedKindSchema,
  source_kind: MemorySeedSourceKindSchema,
  source_ref: z.string(),
  confidence: MemorySeedConfidenceSchema,
  related_paths: z.array(z.string()).optional(),
  tags: TagsWithDefaultSchema,
  promotion_hint: z.enum(['constraint', 'decision', 'trap']).optional(),
});
export type MemorySeedDocument = z.infer<typeof MemorySeedDocumentSchema>;

export const BootstrapProfileDocumentSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  derived_at: z.string(),
  repo_fingerprint: z.string().optional(),
  summary: z.string(),
  sources_scanned: z.array(z.string()).default([]),
  git_available: z.boolean().default(false),
  agents_md_present: z.boolean().default(false),
  seed_count: z.number().int().nonnegative(),
  target: z.string().optional(),
  workspace_kind: z.enum(['empty', 'existing']).optional(),
  onboarding_mode: z.enum(['empty_workspace', 'existing_documented', 'existing_sparse']).optional(),
  confidence: MemorySeedConfidenceSchema.optional(),
  native_instruction_files: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
});
export type BootstrapProfileDocument = z.infer<typeof BootstrapProfileDocumentSchema>;

export const BootstrapSuggestionTargetSchema = z.enum(['instruction', 'decision', 'constraint', 'trap']);
export type BootstrapSuggestionTarget = z.infer<typeof BootstrapSuggestionTargetSchema>;

export const BootstrapSuggestionDocumentSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  id: z.string(),
  target: BootstrapSuggestionTargetSchema,
  text: z.string(),
  rationale: z.string(),
  confidence: MemorySeedConfidenceSchema,
  source_seed_ids: z.array(z.string()).default([]),
  source_refs: z.array(z.string()).default([]),
  layer: z.enum(['global', 'project', 'agent']).optional(),
  scope: z.string().optional(),
  tags: TagsWithDefaultSchema,
  related_paths: z.array(z.string()).optional(),
  category: ConstraintCategorySchema.optional(),
  outcome: DecisionOutcomeSchema.optional(),
  severity: SeveritySchema.optional(),
  reversible: z.boolean().default(true),
});
export type BootstrapSuggestionDocument = z.infer<typeof BootstrapSuggestionDocumentSchema>;

export const BootstrapInterviewAudienceSchema = z.enum(['cli', 'ide_chat', 'any']);
export type BootstrapInterviewAudience = z.infer<typeof BootstrapInterviewAudienceSchema>;

export const BootstrapInterviewQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  rationale: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  audience: BootstrapInterviewAudienceSchema.default('any'),
  response_kind: z.enum(['short_text', 'long_text', 'boolean', 'list']).default('short_text'),
  gap_keys: z.array(z.string()).default([]),
  target_hints: z.array(BootstrapSuggestionTargetSchema).default([]),
});
export type BootstrapInterviewQuestion = z.infer<typeof BootstrapInterviewQuestionSchema>;

export const BootstrapInterviewPlanSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  derived_at: z.string(),
  workspace_kind: z.enum(['empty', 'existing']).optional(),
  audience: BootstrapInterviewAudienceSchema.default('any'),
  summary: z.string(),
  question_count: z.number().int().nonnegative(),
  questions: z.array(BootstrapInterviewQuestionSchema).default([]),
});
export type BootstrapInterviewPlan = z.infer<typeof BootstrapInterviewPlanSchema>;

export const BootstrapInterviewAnswerSuggestionSchema = z.object({
  target: BootstrapSuggestionTargetSchema,
  text: z.string(),
  rationale: z.string().optional(),
  confidence: MemorySeedConfidenceSchema.optional(),
  layer: z.enum(['global', 'project', 'agent']).optional(),
  scope: z.string().optional(),
  tags: TagsWithDefaultSchema,
  related_paths: z.array(z.string()).optional(),
  category: ConstraintCategorySchema.optional(),
  outcome: DecisionOutcomeSchema.optional(),
  severity: SeveritySchema.optional(),
});
export type BootstrapInterviewAnswerSuggestion = z.infer<typeof BootstrapInterviewAnswerSuggestionSchema>;

export const BootstrapInterviewAnswerSchema = z.object({
  question_id: z.string(),
  response_text: z.string().optional(),
  response_items: z.array(z.string()).default([]),
  response_boolean: z.boolean().optional(),
  suggestions: z.array(BootstrapInterviewAnswerSuggestionSchema).default([]),
});
export type BootstrapInterviewAnswer = z.infer<typeof BootstrapInterviewAnswerSchema>;

export const BootstrapImportPlanDocumentSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  derived_at: z.string(),
  target: z.string().optional(),
  workspace_kind: z.enum(['empty', 'existing']).optional(),
  onboarding_mode: z.enum(['empty_workspace', 'existing_documented', 'existing_sparse']).optional(),
  confidence: MemorySeedConfidenceSchema.optional(),
  summary: z.string(),
  requires_confirmation: z.boolean().default(true),
  gaps: z.array(z.string()).default([]),
  confirmed_suggestion_count: z.number().int().nonnegative().default(0),
  interview_answer_count: z.number().int().nonnegative().default(0),
  suggestion_count: z.number().int().nonnegative(),
  suggestions: z.array(BootstrapSuggestionDocumentSchema).default([]),
  interview: BootstrapInterviewPlanSchema.optional(),
});
export type BootstrapImportPlanDocument = z.infer<typeof BootstrapImportPlanDocumentSchema>;

export const BootstrapManagedArtifactSchema = z.object({
  kind: z.enum(['instruction', 'decision', 'constraint', 'trap']),
  id: z.string(),
  suggestion_id: z.string(),
  rollback_action: z.enum(['deactivate', 'delete']).default('delete'),
});
export type BootstrapManagedArtifact = z.infer<typeof BootstrapManagedArtifactSchema>;

export const BootstrapApplicationReceiptSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  applied_at: z.string(),
  proposal_derived_at: z.string(),
  target: z.string().optional(),
  workspace_kind: z.enum(['empty', 'existing']).optional(),
  managed_artifacts: z.array(BootstrapManagedArtifactSchema).default([]),
  suggestion_ids: z.array(z.string()).default([]),
  uninstalled_at: z.string().optional(),
});
export type BootstrapApplicationReceipt = z.infer<typeof BootstrapApplicationReceiptSchema>;

export const AgentIntegrationNameSchema = z.enum([
  'github-copilot',
  'claude-code',
  'cursor',
  'windsurf',
  'cline',
  'codex',
  'opencode',
  'antigravity',
  'continue',
  'roo',
  'openclaw',
  'nanoclaw',
  'nemoclaw',
  'picoclaw',
  'zeroclaw',
]);
export type AgentIntegrationName = z.infer<typeof AgentIntegrationNameSchema>;

export const AgentIntegrationSurfaceKindSchema = z.enum(['instructions', 'mcp', 'skill', 'rule', 'hook']);
export type AgentIntegrationSurfaceKind = z.infer<typeof AgentIntegrationSurfaceKindSchema>;

export const AgentIntegrationLocationSchema = z.enum(['workspace', 'machine']);
export type AgentIntegrationLocation = z.infer<typeof AgentIntegrationLocationSchema>;

export const AgentIntegrationDeclarationSourceSchema = z.enum(['manual', 'detected']);
export type AgentIntegrationDeclarationSource = z.infer<typeof AgentIntegrationDeclarationSourceSchema>;

export const AgentIntegrationSurfaceSchema = z.object({
  kind: AgentIntegrationSurfaceKindSchema,
  location: AgentIntegrationLocationSchema,
  path: z.string().optional(),
});
export type AgentIntegrationSurface = z.infer<typeof AgentIntegrationSurfaceSchema>;

export const AgentIntegrationLevelSchema = z.enum(['full', 'standard', 'limited', 'custom']);
export type AgentIntegrationLevel = z.infer<typeof AgentIntegrationLevelSchema>;

export const AgentIntegrationDeclarationSchema = z.object({
  agent_name: AgentIntegrationNameSchema,
  declaration_source: AgentIntegrationDeclarationSourceSchema.default('manual'),
  level: AgentIntegrationLevelSchema.optional(),
  surfaces: z.array(AgentIntegrationSurfaceSchema).default([]),
  notes: z.string().optional(),
});
export type AgentIntegrationDeclaration = z.infer<typeof AgentIntegrationDeclarationSchema>;

export const AgentIntegrationsConfigSchema = z.object({
  declarations: z.array(AgentIntegrationDeclarationSchema).default([]),
});
export type AgentIntegrationsConfig = z.infer<typeof AgentIntegrationsConfigSchema>;

export const CrossProjectLinkSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  role: z.enum(['subscriber', 'publisher']).default('subscriber'),
});
export type CrossProjectLink = z.infer<typeof CrossProjectLinkSchema>;

export const BrainclawUpdateSourceLocalPackSchema = z.object({
  type: z.literal('local-pack'),
  manifest_path: z.string(),
});
export type BrainclawUpdateSourceLocalPack = z.infer<typeof BrainclawUpdateSourceLocalPackSchema>;

export const BrainclawUpdateSourceNpmSchema = z.object({
  type: z.literal('npm'),
  package_name: z.string().default('brainclaw'),
  dist_tag: z.string().default('latest'),
});
export type BrainclawUpdateSourceNpm = z.infer<typeof BrainclawUpdateSourceNpmSchema>;

export const BrainclawUpdateSourceSchema = z.discriminatedUnion('type', [
  BrainclawUpdateSourceLocalPackSchema,
  BrainclawUpdateSourceNpmSchema,
]);
export type BrainclawUpdateSource = z.infer<typeof BrainclawUpdateSourceSchema>;

export const BrainclawLocalReleaseManifestSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  version: z.literal(1),
  channel: z.literal('local-pack').default('local-pack'),
  package_name: z.string().default('brainclaw'),
  latest_installable_version: z.string(),
  published_at: z.string().optional(),
  artifact_path: z.string().optional(),
  install_command: z.string().optional(),
  release_notes: z.string().optional(),
});
export type BrainclawLocalReleaseManifest = z.infer<typeof BrainclawLocalReleaseManifestSchema>;

export const ConfigSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  version: z.literal(1),
  project_name: z.string(),
  project_id: z.string().optional(),
  minimum_brainclaw_version: z.string().optional(),
  recommended_brainclaw_version: z.string().optional(),
  brainclaw_upgrade_message: z.string().optional(),
  brainclaw_upgrade_command: z.string().optional(),
  brainclaw_update_source: BrainclawUpdateSourceSchema.optional(),
  current_agent: z.string().optional(),
  current_agent_id: z.string().optional(),
  storage_dir: z.string().default('.brainclaw'),
  topology: TopologyModeSchema.default('embedded'),
  ignore_strategy: IgnoreStrategySchema.default('none'),
  project_mode: ProjectModeSchema.default('auto'),
  projects: ProjectsConfigSchema.default({ strategy: 'manual', known: [] }),
  profile: ProfileSchema.optional(),
  target_audience: z.enum(['human', 'agent']).optional().default('human'),
  openclaw_bridge: z.boolean().optional().default(false),
  remote_sync: RemoteSyncSchema.optional(),
  telemetry: z.literal(false),
  allow_network: z.literal(false),
  redaction: RedactionConfigSchema,
  sensitive_paths: z.array(z.string()),
  security: SecurityConfigSchema.optional(),
  markdown: MarkdownConfigSchema.optional(),
  reflective_memory: ReflectiveMemoryConfigSchema.optional(),
  governance: GovernanceConfigSchema.optional(),
  reputation: ReputationConfigSchema.optional(),
  agent_integrations: AgentIntegrationsConfigSchema.default({ declarations: [] }),
  cross_project_links: z.array(CrossProjectLinkSchema).optional().default([]),
  implicit_session_ttl: z.string().default('4h'),
  auto_reflect_notes: z.boolean().default(false),
});
export type Config = z.infer<typeof ConfigSchema>;
