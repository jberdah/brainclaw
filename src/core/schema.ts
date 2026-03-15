import { z } from 'zod';

// --- Entry schemas ---

export const ConstraintStatusSchema = z.enum(['active', 'resolved', 'expired']);
export type ConstraintStatus = z.infer<typeof ConstraintStatusSchema>;

export const SeveritySchema = z.enum(['low', 'medium', 'high']);
export type Severity = z.infer<typeof SeveritySchema>;

export const PrioritySchema = z.enum(['low', 'medium', 'high']);
export type Priority = z.infer<typeof PrioritySchema>;

export const MemoryVisibilitySchema = z.enum(['shared', 'machine', 'private']);
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;

export const HandoffStatusSchema = z.enum(['open', 'accepted', 'closed']);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const ConstraintSchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  status: ConstraintStatusSchema,
  tags: z.array(z.string()),
  related_paths: z.array(z.string()).optional(),
  expires_at: z.string().optional(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  related_paths: z.array(z.string()).optional(),
  tags: z.array(z.string()),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const TrapSchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  project_id: z.string().optional(),
  session_id: z.string().optional(),
  severity: SeveritySchema,
  tags: z.array(z.string()),
  related_paths: z.array(z.string()).optional(),
  visibility: MemoryVisibilitySchema.default('shared'),
  host_id: z.string().optional(),
  expires_at: z.string().optional(),
});
export type Trap = z.infer<typeof TrapSchema>;

export const HandoffSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  status: HandoffStatusSchema,
  project: z.string().optional(),
  plan_id: z.string().optional(),
  tags: z.array(z.string()),
  related_paths: z.array(z.string()).optional(),
  snapshot: z.object({
    diff: z.string().optional(),
  }).optional(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const PlanStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done', 'dropped']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  author: z.string(),
  status: PlanStatusSchema,
  priority: PrioritySchema,
  assignee: z.string().optional(),
  project: z.string().optional(),
  tags: z.array(z.string()),
  related_paths: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).default([]),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const InstructionLayerSchema = z.enum(['global', 'project', 'agent']);
export type InstructionLayer = z.infer<typeof InstructionLayerSchema>;

export const InstructionEntrySchema = z.object({
  id: z.string(),
  layer: InstructionLayerSchema,
  scope: z.string().optional(),
  text: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  author: z.string(),
  tags: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  supersedes: z.string().optional(),
});
export type InstructionEntry = z.infer<typeof InstructionEntrySchema>;

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

export const CandidateSchema = z.object({
  id: z.string(),
  type: CandidateTypeSchema,
  text: z.string(),
  created_at: z.string(),
  author: z.string(),
  author_id: z.string().optional(),
  project_id: z.string().optional(),
  host_id: z.string().optional(),
  session_id: z.string().optional(),
  source: z.string().optional(),
  tags: z.array(z.string()),
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
  id: z.string(),
  agent: z.string(),
  agent_id: z.string().optional(),
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
});
export type Claim = z.infer<typeof ClaimSchema>;

// --- Runtime notes schemas ---

export const RuntimeNoteSchema = z.object({
  id: z.string(),
  agent: z.string(),
  agent_id: z.string().optional(),
  project_id: z.string().optional(),
  session_id: z.string().optional(),
  text: z.string(),
  created_at: z.string(),
  project: z.string().optional(),
  plan_id: z.string().optional(),
  tags: z.array(z.string()),
  visibility: MemoryVisibilitySchema.default('shared'),
  host_id: z.string().optional(),
  expires_at: z.string().optional(),
  note_type: z.enum(['observation', 'session_start', 'session_end']).default('observation'),
});
export type RuntimeNote = z.infer<typeof RuntimeNoteSchema>;

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
  tags: z.array(z.string()).default([]),
  // Optional routing and type hints for candidate generation
  candidate_type: CandidateTypeSchema.optional(),
  severity: SeveritySchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  related_paths: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
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

export const AgentKindSchema = z.enum(['agent', 'human', 'unknown']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AgentTrustLevelSchema = z.enum(['observer', 'contributor', 'trusted', 'curator']);
export type AgentTrustLevel = z.infer<typeof AgentTrustLevelSchema>;

export const ProjectIdentityDocumentSchema = z.object({
  version: z.literal(1),
  project_id: z.string(),
  project_name: z.string(),
  created_at: z.string(),
  storage_dir: z.string(),
  topology: TopologyModeSchema,
});
export type ProjectIdentityDocument = z.infer<typeof ProjectIdentityDocumentSchema>;

export const AgentIdentityDocumentSchema = z.object({
  version: z.literal(1),
  agent_id: z.string(),
  agent_name: z.string(),
  created_at: z.string(),
  kind: AgentKindSchema.default('unknown'),
  trust_level: AgentTrustLevelSchema.default('contributor'),
  capabilities: z.array(z.string()).default([]),
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
  session_id: z.string(),
  agent: z.string(),
  agent_id: z.string().optional(),
  started_at: z.string(),
  context_target: z.string().optional(),
  initial_context_hash: z.string().optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1),
  project_name: z.string(),
  project_id: z.string().optional(),
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
});
export type Config = z.infer<typeof ConfigSchema>;
