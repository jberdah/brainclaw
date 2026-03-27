import { z } from 'zod';
/** Resilient tags schema that accepts string[] or JSON-serialized string. */
export declare const TagsSchema: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
export declare const TagsWithDefaultSchema: z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodString, "many">>, string[], unknown>;
export declare const ConstraintStatusSchema: z.ZodEnum<["active", "resolved", "expired"]>;
export type ConstraintStatus = z.infer<typeof ConstraintStatusSchema>;
export declare const ConstraintCategorySchema: z.ZodEnum<["architecture", "performance", "security", "reliability", "compatibility", "process", "other"]>;
export type ConstraintCategory = z.infer<typeof ConstraintCategorySchema>;
export declare const SeveritySchema: z.ZodEnum<["low", "medium", "high"]>;
export type Severity = z.infer<typeof SeveritySchema>;
export declare const TrapStatusSchema: z.ZodEnum<["active", "resolved", "expired"]>;
export type TrapStatus = z.infer<typeof TrapStatusSchema>;
export declare const PrioritySchema: z.ZodEnum<["low", "medium", "high"]>;
export type Priority = z.infer<typeof PrioritySchema>;
export declare const MemoryVisibilitySchema: z.ZodEnum<["shared", "machine", "private"]>;
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;
export declare const HandoffStatusSchema: z.ZodEnum<["open", "accepted", "closed"]>;
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;
export declare const DecisionOutcomeSchema: z.ZodEnum<["approved", "rejected", "deferred", "pending"]>;
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;
export declare const MemoryScopeSchema: z.ZodDefault<z.ZodEnum<["project", "machine", "user"]>>;
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export declare const ConstraintSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    short_label: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    created_at: z.ZodString;
    author: z.ZodString;
    author_id: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    project_id: z.ZodOptional<z.ZodString>;
    host_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["active", "resolved", "expired"]>;
    category: z.ZodOptional<z.ZodEnum<["architecture", "performance", "security", "reliability", "compatibility", "process", "other"]>>;
    scope: z.ZodOptional<z.ZodDefault<z.ZodEnum<["project", "machine", "user"]>>>;
    tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    expires_at: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "active" | "resolved" | "expired";
    id: string;
    text: string;
    created_at: string;
    author: string;
    tags: string[];
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
    scope?: "machine" | "project" | "user" | undefined;
    related_paths?: string[] | undefined;
    expires_at?: string | undefined;
}, {
    status: "active" | "resolved" | "expired";
    id: string;
    text: string;
    created_at: string;
    author: string;
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
    scope?: "machine" | "project" | "user" | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    expires_at?: string | undefined;
}>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export declare const DecisionSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    short_label: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    created_at: z.ZodString;
    author: z.ZodString;
    author_id: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    project_id: z.ZodOptional<z.ZodString>;
    host_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    outcome: z.ZodOptional<z.ZodEnum<["approved", "rejected", "deferred", "pending"]>>;
    scope: z.ZodOptional<z.ZodDefault<z.ZodEnum<["project", "machine", "user"]>>>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    plan_id: z.ZodOptional<z.ZodString>;
    tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    created_at: string;
    author: string;
    tags: string[];
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    scope?: "machine" | "project" | "user" | undefined;
    related_paths?: string[] | undefined;
    outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
    plan_id?: string | undefined;
}, {
    id: string;
    text: string;
    created_at: string;
    author: string;
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    scope?: "machine" | "project" | "user" | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
    plan_id?: string | undefined;
}>;
export type Decision = z.infer<typeof DecisionSchema>;
export declare const TrapSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    short_label: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    created_at: z.ZodString;
    author: z.ZodString;
    author_id: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    project_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<["active", "resolved", "expired"]>>;
    severity: z.ZodEnum<["low", "medium", "high"]>;
    scope: z.ZodOptional<z.ZodDefault<z.ZodEnum<["project", "machine", "user"]>>>;
    tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    plan_id: z.ZodOptional<z.ZodString>;
    visibility: z.ZodDefault<z.ZodEnum<["shared", "machine", "private"]>>;
    host_id: z.ZodOptional<z.ZodString>;
    expires_at: z.ZodOptional<z.ZodString>;
    platform_scope: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "active" | "resolved" | "expired";
    id: string;
    text: string;
    created_at: string;
    author: string;
    tags: string[];
    severity: "low" | "medium" | "high";
    visibility: "shared" | "machine" | "private";
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    scope?: "machine" | "project" | "user" | undefined;
    related_paths?: string[] | undefined;
    expires_at?: string | undefined;
    plan_id?: string | undefined;
    platform_scope?: string | undefined;
}, {
    id: string;
    text: string;
    created_at: string;
    author: string;
    severity: "low" | "medium" | "high";
    status?: "active" | "resolved" | "expired" | undefined;
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    scope?: "machine" | "project" | "user" | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    expires_at?: string | undefined;
    plan_id?: string | undefined;
    visibility?: "shared" | "machine" | "private" | undefined;
    platform_scope?: string | undefined;
}>;
export type Trap = z.infer<typeof TrapSchema>;
export declare const HandoffContractSchema: z.ZodObject<{
    files_touched: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    pre_conditions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    post_conditions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    tests_to_verify: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    linked_plans: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    files_touched?: string[] | undefined;
    pre_conditions?: string[] | undefined;
    post_conditions?: string[] | undefined;
    tests_to_verify?: string[] | undefined;
    linked_plans?: string[] | undefined;
}, {
    files_touched?: string[] | undefined;
    pre_conditions?: string[] | undefined;
    post_conditions?: string[] | undefined;
    tests_to_verify?: string[] | undefined;
    linked_plans?: string[] | undefined;
}>;
export type HandoffContract = z.infer<typeof HandoffContractSchema>;
export declare const HandoffSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    short_label: z.ZodOptional<z.ZodString>;
    from: z.ZodString;
    to: z.ZodString;
    text: z.ZodString;
    created_at: z.ZodString;
    author: z.ZodString;
    author_id: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    project_id: z.ZodOptional<z.ZodString>;
    host_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["open", "accepted", "closed"]>;
    project: z.ZodOptional<z.ZodString>;
    plan_id: z.ZodOptional<z.ZodString>;
    tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    contract: z.ZodOptional<z.ZodObject<{
        files_touched: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        pre_conditions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        post_conditions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        tests_to_verify: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        linked_plans: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        files_touched?: string[] | undefined;
        pre_conditions?: string[] | undefined;
        post_conditions?: string[] | undefined;
        tests_to_verify?: string[] | undefined;
        linked_plans?: string[] | undefined;
    }, {
        files_touched?: string[] | undefined;
        pre_conditions?: string[] | undefined;
        post_conditions?: string[] | undefined;
        tests_to_verify?: string[] | undefined;
        linked_plans?: string[] | undefined;
    }>>;
    snapshot: z.ZodOptional<z.ZodObject<{
        diff: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        diff?: string | undefined;
    }, {
        diff?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    status: "open" | "accepted" | "closed";
    id: string;
    text: string;
    created_at: string;
    author: string;
    tags: string[];
    from: string;
    to: string;
    project?: string | undefined;
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    related_paths?: string[] | undefined;
    plan_id?: string | undefined;
    contract?: {
        files_touched?: string[] | undefined;
        pre_conditions?: string[] | undefined;
        post_conditions?: string[] | undefined;
        tests_to_verify?: string[] | undefined;
        linked_plans?: string[] | undefined;
    } | undefined;
    snapshot?: {
        diff?: string | undefined;
    } | undefined;
}, {
    status: "open" | "accepted" | "closed";
    id: string;
    text: string;
    created_at: string;
    author: string;
    from: string;
    to: string;
    project?: string | undefined;
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    plan_id?: string | undefined;
    contract?: {
        files_touched?: string[] | undefined;
        pre_conditions?: string[] | undefined;
        post_conditions?: string[] | undefined;
        tests_to_verify?: string[] | undefined;
        linked_plans?: string[] | undefined;
    } | undefined;
    snapshot?: {
        diff?: string | undefined;
    } | undefined;
}>;
export type Handoff = z.infer<typeof HandoffSchema>;
export declare const PlanStatusSchema: z.ZodEnum<["todo", "in_progress", "blocked", "done", "dropped"]>;
export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export declare const PlanStepStatusSchema: z.ZodEnum<["todo", "in_progress", "testing", "done", "blocked"]>;
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;
export declare const PlanStepSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    status: z.ZodDefault<z.ZodEnum<["todo", "in_progress", "testing", "done", "blocked"]>>;
    assignee: z.ZodOptional<z.ZodString>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "todo" | "in_progress" | "blocked" | "done" | "testing";
    id: string;
    text: string;
    created_at: string;
    updated_at: string;
    assignee?: string | undefined;
}, {
    id: string;
    text: string;
    created_at: string;
    updated_at: string;
    status?: "todo" | "in_progress" | "blocked" | "done" | "testing" | undefined;
    assignee?: string | undefined;
}>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export declare const PlanTypeSchema: z.ZodDefault<z.ZodEnum<["feat", "fix", "chore", "spike", "doc"]>>;
export type PlanType = z.infer<typeof PlanTypeSchema>;
export declare const PlanItemSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    short_label: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["feat", "fix", "chore", "spike", "doc"]>>>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    author: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["todo", "in_progress", "blocked", "done", "dropped"]>;
    priority: z.ZodEnum<["low", "medium", "high"]>;
    assignee: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        status: z.ZodDefault<z.ZodEnum<["todo", "in_progress", "testing", "done", "blocked"]>>;
        assignee: z.ZodOptional<z.ZodString>;
        created_at: z.ZodString;
        updated_at: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        status: "todo" | "in_progress" | "blocked" | "done" | "testing";
        id: string;
        text: string;
        created_at: string;
        updated_at: string;
        assignee?: string | undefined;
    }, {
        id: string;
        text: string;
        created_at: string;
        updated_at: string;
        status?: "todo" | "in_progress" | "blocked" | "done" | "testing" | undefined;
        assignee?: string | undefined;
    }>, "many">>;
    estimated_effort: z.ZodEffects<z.ZodOptional<z.ZodNumber>, number | undefined, unknown>;
    actual_effort: z.ZodOptional<z.ZodString>;
    started_at: z.ZodOptional<z.ZodString>;
    completed_at: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "todo" | "in_progress" | "blocked" | "done" | "dropped";
    id: string;
    text: string;
    created_at: string;
    author: string;
    tags: string[];
    updated_at: string;
    priority: "low" | "medium" | "high";
    depends_on: string[];
    type?: "feat" | "fix" | "chore" | "spike" | "doc" | undefined;
    project?: string | undefined;
    schema_version?: number | undefined;
    short_label?: string | undefined;
    model?: string | undefined;
    related_paths?: string[] | undefined;
    assignee?: string | undefined;
    steps?: {
        status: "todo" | "in_progress" | "blocked" | "done" | "testing";
        id: string;
        text: string;
        created_at: string;
        updated_at: string;
        assignee?: string | undefined;
    }[] | undefined;
    estimated_effort?: number | undefined;
    actual_effort?: string | undefined;
    started_at?: string | undefined;
    completed_at?: string | undefined;
}, {
    status: "todo" | "in_progress" | "blocked" | "done" | "dropped";
    id: string;
    text: string;
    created_at: string;
    author: string;
    updated_at: string;
    priority: "low" | "medium" | "high";
    type?: "feat" | "fix" | "chore" | "spike" | "doc" | undefined;
    project?: string | undefined;
    schema_version?: number | undefined;
    short_label?: string | undefined;
    model?: string | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    assignee?: string | undefined;
    depends_on?: string[] | undefined;
    steps?: {
        id: string;
        text: string;
        created_at: string;
        updated_at: string;
        status?: "todo" | "in_progress" | "blocked" | "done" | "testing" | undefined;
        assignee?: string | undefined;
    }[] | undefined;
    estimated_effort?: unknown;
    actual_effort?: string | undefined;
    started_at?: string | undefined;
    completed_at?: string | undefined;
}>;
export type PlanItem = z.infer<typeof PlanItemSchema>;
export declare const InstructionLayerSchema: z.ZodEnum<["global", "project", "agent"]>;
export type InstructionLayer = z.infer<typeof InstructionLayerSchema>;
export declare const InstructionEntrySchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    layer: z.ZodEnum<["global", "project", "agent"]>;
    scope: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    author: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    tags: z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodString, "many">>, string[], unknown>;
    active: z.ZodDefault<z.ZodBoolean>;
    supersedes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    active: boolean;
    id: string;
    text: string;
    created_at: string;
    author: string;
    tags: string[];
    updated_at: string;
    layer: "project" | "global" | "agent";
    schema_version?: number | undefined;
    model?: string | undefined;
    scope?: string | undefined;
    supersedes?: string | undefined;
}, {
    id: string;
    text: string;
    created_at: string;
    author: string;
    updated_at: string;
    layer: "project" | "global" | "agent";
    active?: boolean | undefined;
    schema_version?: number | undefined;
    model?: string | undefined;
    scope?: string | undefined;
    tags?: unknown;
    supersedes?: string | undefined;
}>;
export type InstructionEntry = z.infer<typeof InstructionEntrySchema>;
export declare const CapabilityStatusSchema: z.ZodEnum<["stable", "experimental", "deprecated"]>;
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
export declare const ProjectCapabilitySchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    category: z.ZodString;
    provided_by: z.ZodOptional<z.ZodString>;
    requires: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
    example_usage: z.ZodOptional<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<["stable", "experimental", "deprecated"]>>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    created_at: z.ZodString;
    author: z.ZodString;
    author_id: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "stable" | "experimental" | "deprecated";
    id: string;
    created_at: string;
    author: string;
    category: string;
    tags: string[];
    name: string;
    description: string;
    schema_version?: number | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    related_paths?: string[] | undefined;
    provided_by?: string | undefined;
    requires?: string[] | undefined;
    example_usage?: string | undefined;
}, {
    id: string;
    created_at: string;
    author: string;
    category: string;
    name: string;
    description: string;
    status?: "stable" | "experimental" | "deprecated" | undefined;
    schema_version?: number | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    provided_by?: string | undefined;
    requires?: string[] | undefined;
    example_usage?: string | undefined;
}>;
export type ProjectCapability = z.infer<typeof ProjectCapabilitySchema>;
export declare const ToolTypeSchema: z.ZodEnum<["workflow", "validator", "generator", "utility", "explorer"]>;
export type ToolType = z.infer<typeof ToolTypeSchema>;
export declare const ProjectToolSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    type: z.ZodEnum<["workflow", "validator", "generator", "utility", "explorer"]>;
    implementation: z.ZodString;
    mcp_name: z.ZodOptional<z.ZodString>;
    cli_command: z.ZodOptional<z.ZodString>;
    requires: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    suggests_for: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    invocation_example: z.ZodOptional<z.ZodString>;
    tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
    status: z.ZodDefault<z.ZodEnum<["stable", "experimental", "deprecated"]>>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    created_at: z.ZodString;
    author: z.ZodString;
    author_id: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "stable" | "experimental" | "deprecated";
    type: "workflow" | "validator" | "generator" | "utility" | "explorer";
    id: string;
    created_at: string;
    author: string;
    tags: string[];
    name: string;
    description: string;
    implementation: string;
    schema_version?: number | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    related_paths?: string[] | undefined;
    requires?: string[] | undefined;
    mcp_name?: string | undefined;
    cli_command?: string | undefined;
    suggests_for?: string[] | undefined;
    invocation_example?: string | undefined;
}, {
    type: "workflow" | "validator" | "generator" | "utility" | "explorer";
    id: string;
    created_at: string;
    author: string;
    name: string;
    description: string;
    implementation: string;
    status?: "stable" | "experimental" | "deprecated" | undefined;
    schema_version?: number | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    requires?: string[] | undefined;
    mcp_name?: string | undefined;
    cli_command?: string | undefined;
    suggests_for?: string[] | undefined;
    invocation_example?: string | undefined;
}>;
export type ProjectTool = z.infer<typeof ProjectToolSchema>;
export declare const StateSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    write_version: z.ZodDefault<z.ZodNumber>;
    active_constraints: z.ZodArray<z.ZodObject<{
        schema_version: z.ZodOptional<z.ZodNumber>;
        id: z.ZodString;
        short_label: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        created_at: z.ZodString;
        author: z.ZodString;
        author_id: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        project_id: z.ZodOptional<z.ZodString>;
        host_id: z.ZodOptional<z.ZodString>;
        session_id: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<["active", "resolved", "expired"]>;
        category: z.ZodOptional<z.ZodEnum<["architecture", "performance", "security", "reliability", "compatibility", "process", "other"]>>;
        scope: z.ZodOptional<z.ZodDefault<z.ZodEnum<["project", "machine", "user"]>>>;
        tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
        related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        expires_at: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "active" | "resolved" | "expired";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        related_paths?: string[] | undefined;
        expires_at?: string | undefined;
    }, {
        status: "active" | "resolved" | "expired";
        id: string;
        text: string;
        created_at: string;
        author: string;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        expires_at?: string | undefined;
    }>, "many">;
    recent_decisions: z.ZodArray<z.ZodObject<{
        schema_version: z.ZodOptional<z.ZodNumber>;
        id: z.ZodString;
        short_label: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        created_at: z.ZodString;
        author: z.ZodString;
        author_id: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        project_id: z.ZodOptional<z.ZodString>;
        host_id: z.ZodOptional<z.ZodString>;
        session_id: z.ZodOptional<z.ZodString>;
        outcome: z.ZodOptional<z.ZodEnum<["approved", "rejected", "deferred", "pending"]>>;
        scope: z.ZodOptional<z.ZodDefault<z.ZodEnum<["project", "machine", "user"]>>>;
        related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        plan_id: z.ZodOptional<z.ZodString>;
        tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        plan_id?: string | undefined;
    }, {
        id: string;
        text: string;
        created_at: string;
        author: string;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        plan_id?: string | undefined;
    }>, "many">;
    known_traps: z.ZodArray<z.ZodObject<{
        schema_version: z.ZodOptional<z.ZodNumber>;
        id: z.ZodString;
        short_label: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        created_at: z.ZodString;
        author: z.ZodString;
        author_id: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        project_id: z.ZodOptional<z.ZodString>;
        session_id: z.ZodOptional<z.ZodString>;
        status: z.ZodDefault<z.ZodEnum<["active", "resolved", "expired"]>>;
        severity: z.ZodEnum<["low", "medium", "high"]>;
        scope: z.ZodOptional<z.ZodDefault<z.ZodEnum<["project", "machine", "user"]>>>;
        tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
        related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        plan_id: z.ZodOptional<z.ZodString>;
        visibility: z.ZodDefault<z.ZodEnum<["shared", "machine", "private"]>>;
        host_id: z.ZodOptional<z.ZodString>;
        expires_at: z.ZodOptional<z.ZodString>;
        platform_scope: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "active" | "resolved" | "expired";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        severity: "low" | "medium" | "high";
        visibility: "shared" | "machine" | "private";
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        related_paths?: string[] | undefined;
        expires_at?: string | undefined;
        plan_id?: string | undefined;
        platform_scope?: string | undefined;
    }, {
        id: string;
        text: string;
        created_at: string;
        author: string;
        severity: "low" | "medium" | "high";
        status?: "active" | "resolved" | "expired" | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        expires_at?: string | undefined;
        plan_id?: string | undefined;
        visibility?: "shared" | "machine" | "private" | undefined;
        platform_scope?: string | undefined;
    }>, "many">;
    open_handoffs: z.ZodArray<z.ZodObject<{
        schema_version: z.ZodOptional<z.ZodNumber>;
        id: z.ZodString;
        short_label: z.ZodOptional<z.ZodString>;
        from: z.ZodString;
        to: z.ZodString;
        text: z.ZodString;
        created_at: z.ZodString;
        author: z.ZodString;
        author_id: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        project_id: z.ZodOptional<z.ZodString>;
        host_id: z.ZodOptional<z.ZodString>;
        session_id: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<["open", "accepted", "closed"]>;
        project: z.ZodOptional<z.ZodString>;
        plan_id: z.ZodOptional<z.ZodString>;
        tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
        related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        contract: z.ZodOptional<z.ZodObject<{
            files_touched: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            pre_conditions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            post_conditions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            tests_to_verify: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            linked_plans: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            files_touched?: string[] | undefined;
            pre_conditions?: string[] | undefined;
            post_conditions?: string[] | undefined;
            tests_to_verify?: string[] | undefined;
            linked_plans?: string[] | undefined;
        }, {
            files_touched?: string[] | undefined;
            pre_conditions?: string[] | undefined;
            post_conditions?: string[] | undefined;
            tests_to_verify?: string[] | undefined;
            linked_plans?: string[] | undefined;
        }>>;
        snapshot: z.ZodOptional<z.ZodObject<{
            diff: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            diff?: string | undefined;
        }, {
            diff?: string | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        status: "open" | "accepted" | "closed";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        from: string;
        to: string;
        project?: string | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        related_paths?: string[] | undefined;
        plan_id?: string | undefined;
        contract?: {
            files_touched?: string[] | undefined;
            pre_conditions?: string[] | undefined;
            post_conditions?: string[] | undefined;
            tests_to_verify?: string[] | undefined;
            linked_plans?: string[] | undefined;
        } | undefined;
        snapshot?: {
            diff?: string | undefined;
        } | undefined;
    }, {
        status: "open" | "accepted" | "closed";
        id: string;
        text: string;
        created_at: string;
        author: string;
        from: string;
        to: string;
        project?: string | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        plan_id?: string | undefined;
        contract?: {
            files_touched?: string[] | undefined;
            pre_conditions?: string[] | undefined;
            post_conditions?: string[] | undefined;
            tests_to_verify?: string[] | undefined;
            linked_plans?: string[] | undefined;
        } | undefined;
        snapshot?: {
            diff?: string | undefined;
        } | undefined;
    }>, "many">;
    plan_items: z.ZodDefault<z.ZodArray<z.ZodObject<{
        schema_version: z.ZodOptional<z.ZodNumber>;
        id: z.ZodString;
        short_label: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["feat", "fix", "chore", "spike", "doc"]>>>;
        created_at: z.ZodString;
        updated_at: z.ZodString;
        author: z.ZodString;
        model: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<["todo", "in_progress", "blocked", "done", "dropped"]>;
        priority: z.ZodEnum<["low", "medium", "high"]>;
        assignee: z.ZodOptional<z.ZodString>;
        project: z.ZodOptional<z.ZodString>;
        tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
        related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            text: z.ZodString;
            status: z.ZodDefault<z.ZodEnum<["todo", "in_progress", "testing", "done", "blocked"]>>;
            assignee: z.ZodOptional<z.ZodString>;
            created_at: z.ZodString;
            updated_at: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            status: "todo" | "in_progress" | "blocked" | "done" | "testing";
            id: string;
            text: string;
            created_at: string;
            updated_at: string;
            assignee?: string | undefined;
        }, {
            id: string;
            text: string;
            created_at: string;
            updated_at: string;
            status?: "todo" | "in_progress" | "blocked" | "done" | "testing" | undefined;
            assignee?: string | undefined;
        }>, "many">>;
        estimated_effort: z.ZodEffects<z.ZodOptional<z.ZodNumber>, number | undefined, unknown>;
        actual_effort: z.ZodOptional<z.ZodString>;
        started_at: z.ZodOptional<z.ZodString>;
        completed_at: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "todo" | "in_progress" | "blocked" | "done" | "dropped";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        updated_at: string;
        priority: "low" | "medium" | "high";
        depends_on: string[];
        type?: "feat" | "fix" | "chore" | "spike" | "doc" | undefined;
        project?: string | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        model?: string | undefined;
        related_paths?: string[] | undefined;
        assignee?: string | undefined;
        steps?: {
            status: "todo" | "in_progress" | "blocked" | "done" | "testing";
            id: string;
            text: string;
            created_at: string;
            updated_at: string;
            assignee?: string | undefined;
        }[] | undefined;
        estimated_effort?: number | undefined;
        actual_effort?: string | undefined;
        started_at?: string | undefined;
        completed_at?: string | undefined;
    }, {
        status: "todo" | "in_progress" | "blocked" | "done" | "dropped";
        id: string;
        text: string;
        created_at: string;
        author: string;
        updated_at: string;
        priority: "low" | "medium" | "high";
        type?: "feat" | "fix" | "chore" | "spike" | "doc" | undefined;
        project?: string | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        model?: string | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        assignee?: string | undefined;
        depends_on?: string[] | undefined;
        steps?: {
            id: string;
            text: string;
            created_at: string;
            updated_at: string;
            status?: "todo" | "in_progress" | "blocked" | "done" | "testing" | undefined;
            assignee?: string | undefined;
        }[] | undefined;
        estimated_effort?: unknown;
        actual_effort?: string | undefined;
        started_at?: string | undefined;
        completed_at?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    version: 1;
    write_version: number;
    active_constraints: {
        status: "active" | "resolved" | "expired";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        related_paths?: string[] | undefined;
        expires_at?: string | undefined;
    }[];
    recent_decisions: {
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        plan_id?: string | undefined;
    }[];
    known_traps: {
        status: "active" | "resolved" | "expired";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        severity: "low" | "medium" | "high";
        visibility: "shared" | "machine" | "private";
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        related_paths?: string[] | undefined;
        expires_at?: string | undefined;
        plan_id?: string | undefined;
        platform_scope?: string | undefined;
    }[];
    open_handoffs: {
        status: "open" | "accepted" | "closed";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        from: string;
        to: string;
        project?: string | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        related_paths?: string[] | undefined;
        plan_id?: string | undefined;
        contract?: {
            files_touched?: string[] | undefined;
            pre_conditions?: string[] | undefined;
            post_conditions?: string[] | undefined;
            tests_to_verify?: string[] | undefined;
            linked_plans?: string[] | undefined;
        } | undefined;
        snapshot?: {
            diff?: string | undefined;
        } | undefined;
    }[];
    plan_items: {
        status: "todo" | "in_progress" | "blocked" | "done" | "dropped";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        updated_at: string;
        priority: "low" | "medium" | "high";
        depends_on: string[];
        type?: "feat" | "fix" | "chore" | "spike" | "doc" | undefined;
        project?: string | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        model?: string | undefined;
        related_paths?: string[] | undefined;
        assignee?: string | undefined;
        steps?: {
            status: "todo" | "in_progress" | "blocked" | "done" | "testing";
            id: string;
            text: string;
            created_at: string;
            updated_at: string;
            assignee?: string | undefined;
        }[] | undefined;
        estimated_effort?: number | undefined;
        actual_effort?: string | undefined;
        started_at?: string | undefined;
        completed_at?: string | undefined;
    }[];
}, {
    version: 1;
    active_constraints: {
        status: "active" | "resolved" | "expired";
        id: string;
        text: string;
        created_at: string;
        author: string;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        expires_at?: string | undefined;
    }[];
    recent_decisions: {
        id: string;
        text: string;
        created_at: string;
        author: string;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        plan_id?: string | undefined;
    }[];
    known_traps: {
        id: string;
        text: string;
        created_at: string;
        author: string;
        severity: "low" | "medium" | "high";
        status?: "active" | "resolved" | "expired" | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        scope?: "machine" | "project" | "user" | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        expires_at?: string | undefined;
        plan_id?: string | undefined;
        visibility?: "shared" | "machine" | "private" | undefined;
        platform_scope?: string | undefined;
    }[];
    open_handoffs: {
        status: "open" | "accepted" | "closed";
        id: string;
        text: string;
        created_at: string;
        author: string;
        from: string;
        to: string;
        project?: string | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        plan_id?: string | undefined;
        contract?: {
            files_touched?: string[] | undefined;
            pre_conditions?: string[] | undefined;
            post_conditions?: string[] | undefined;
            tests_to_verify?: string[] | undefined;
            linked_plans?: string[] | undefined;
        } | undefined;
        snapshot?: {
            diff?: string | undefined;
        } | undefined;
    }[];
    write_version?: number | undefined;
    plan_items?: {
        status: "todo" | "in_progress" | "blocked" | "done" | "dropped";
        id: string;
        text: string;
        created_at: string;
        author: string;
        updated_at: string;
        priority: "low" | "medium" | "high";
        type?: "feat" | "fix" | "chore" | "spike" | "doc" | undefined;
        project?: string | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        model?: string | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        assignee?: string | undefined;
        depends_on?: string[] | undefined;
        steps?: {
            id: string;
            text: string;
            created_at: string;
            updated_at: string;
            status?: "todo" | "in_progress" | "blocked" | "done" | "testing" | undefined;
            assignee?: string | undefined;
        }[] | undefined;
        estimated_effort?: unknown;
        actual_effort?: string | undefined;
        started_at?: string | undefined;
        completed_at?: string | undefined;
    }[] | undefined;
}>;
export type State = z.infer<typeof StateSchema>;
export declare const RedactionConfigSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    patterns: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    patterns: string[];
}, {
    enabled: boolean;
    patterns: string[];
}>;
export declare const SecurityConfigSchema: z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<["warn", "strict"]>>;
    strict_redaction: z.ZodDefault<z.ZodBoolean>;
    block_sensitive_paths: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    mode: "warn" | "strict";
    strict_redaction: boolean;
    block_sensitive_paths: boolean;
}, {
    mode?: "warn" | "strict" | undefined;
    strict_redaction?: boolean | undefined;
    block_sensitive_paths?: boolean | undefined;
}>;
export declare const MarkdownConfigSchema: z.ZodObject<{
    max_items_per_section: z.ZodDefault<z.ZodNumber>;
    compact_mode: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    max_items_per_section: number;
    compact_mode: boolean;
}, {
    max_items_per_section?: number | undefined;
    compact_mode?: boolean | undefined;
}>;
export declare const CandidateTypeSchema: z.ZodEnum<["constraint", "decision", "trap", "handoff"]>;
export type CandidateType = z.infer<typeof CandidateTypeSchema>;
export declare const CandidateStatusSchema: z.ZodEnum<["pending", "accepted", "rejected"]>;
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;
export declare const CandidateUseSchema: z.ZodObject<{
    by: z.ZodString;
    context: z.ZodString;
    created_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    created_at: string;
    by: string;
    context: string;
}, {
    created_at: string;
    by: string;
    context: string;
}>;
export type CandidateUse = z.infer<typeof CandidateUseSchema>;
export declare const ContradictionSeveritySchema: z.ZodEnum<["low", "medium", "high"]>;
export type ContradictionSeverity = z.infer<typeof ContradictionSeveritySchema>;
export declare const CandidateContradictionSchema: z.ZodObject<{
    item_id: z.ZodString;
    conflicts_with: z.ZodString;
    reason: z.ZodString;
    section: z.ZodString;
    severity: z.ZodEnum<["low", "medium", "high"]>;
    score: z.ZodNumber;
    kind: z.ZodString;
}, "strip", z.ZodTypeAny, {
    severity: "low" | "medium" | "high";
    item_id: string;
    conflicts_with: string;
    reason: string;
    section: string;
    score: number;
    kind: string;
}, {
    severity: "low" | "medium" | "high";
    item_id: string;
    conflicts_with: string;
    reason: string;
    section: string;
    score: number;
    kind: string;
}>;
export type CandidateContradiction = z.infer<typeof CandidateContradictionSchema>;
export declare const CandidateSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    short_label: z.ZodOptional<z.ZodString>;
    type: z.ZodEnum<["constraint", "decision", "trap", "handoff"]>;
    text: z.ZodString;
    created_at: z.ZodString;
    author: z.ZodString;
    author_id: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    project_id: z.ZodOptional<z.ZodString>;
    host_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
    tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
    status: z.ZodEnum<["pending", "accepted", "rejected"]>;
    severity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    star_count: z.ZodDefault<z.ZodNumber>;
    starred_by: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    last_starred_at: z.ZodOptional<z.ZodString>;
    usage_count: z.ZodDefault<z.ZodNumber>;
    usage_events: z.ZodDefault<z.ZodArray<z.ZodObject<{
        by: z.ZodString;
        context: z.ZodString;
        created_at: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        created_at: string;
        by: string;
        context: string;
    }, {
        created_at: string;
        by: string;
        context: string;
    }>, "many">>;
    last_used_at: z.ZodOptional<z.ZodString>;
    plan_id: z.ZodOptional<z.ZodString>;
    contradictions_detected: z.ZodOptional<z.ZodArray<z.ZodObject<{
        item_id: z.ZodString;
        conflicts_with: z.ZodString;
        reason: z.ZodString;
        section: z.ZodString;
        severity: z.ZodEnum<["low", "medium", "high"]>;
        score: z.ZodNumber;
        kind: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        severity: "low" | "medium" | "high";
        item_id: string;
        conflicts_with: string;
        reason: string;
        section: string;
        score: number;
        kind: string;
    }, {
        severity: "low" | "medium" | "high";
        item_id: string;
        conflicts_with: string;
        reason: string;
        section: string;
        score: number;
        kind: string;
    }>, "many">>;
    contradiction_summary: z.ZodOptional<z.ZodString>;
    promotion_blocked_reason: z.ZodOptional<z.ZodString>;
    resolved_at: z.ZodOptional<z.ZodString>;
    resolved_by: z.ZodOptional<z.ZodString>;
    resolution_reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "accepted" | "rejected" | "pending";
    type: "constraint" | "decision" | "trap" | "handoff";
    id: string;
    text: string;
    created_at: string;
    author: string;
    tags: string[];
    star_count: number;
    starred_by: string[];
    usage_count: number;
    usage_events: {
        created_at: string;
        by: string;
        context: string;
    }[];
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    related_paths?: string[] | undefined;
    plan_id?: string | undefined;
    severity?: "low" | "medium" | "high" | undefined;
    from?: string | undefined;
    to?: string | undefined;
    source?: string | undefined;
    last_starred_at?: string | undefined;
    last_used_at?: string | undefined;
    contradictions_detected?: {
        severity: "low" | "medium" | "high";
        item_id: string;
        conflicts_with: string;
        reason: string;
        section: string;
        score: number;
        kind: string;
    }[] | undefined;
    contradiction_summary?: string | undefined;
    promotion_blocked_reason?: string | undefined;
    resolved_at?: string | undefined;
    resolved_by?: string | undefined;
    resolution_reason?: string | undefined;
}, {
    status: "accepted" | "rejected" | "pending";
    type: "constraint" | "decision" | "trap" | "handoff";
    id: string;
    text: string;
    created_at: string;
    author: string;
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    plan_id?: string | undefined;
    severity?: "low" | "medium" | "high" | undefined;
    from?: string | undefined;
    to?: string | undefined;
    source?: string | undefined;
    star_count?: number | undefined;
    starred_by?: string[] | undefined;
    last_starred_at?: string | undefined;
    usage_count?: number | undefined;
    usage_events?: {
        created_at: string;
        by: string;
        context: string;
    }[] | undefined;
    last_used_at?: string | undefined;
    contradictions_detected?: {
        severity: "low" | "medium" | "high";
        item_id: string;
        conflicts_with: string;
        reason: string;
        section: string;
        score: number;
        kind: string;
    }[] | undefined;
    contradiction_summary?: string | undefined;
    promotion_blocked_reason?: string | undefined;
    resolved_at?: string | undefined;
    resolved_by?: string | undefined;
    resolution_reason?: string | undefined;
}>;
export type Candidate = z.infer<typeof CandidateSchema>;
export declare const ReflectiveMemoryConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    auto_accept: z.ZodDefault<z.ZodBoolean>;
    max_pending: z.ZodDefault<z.ZodNumber>;
    promotion_stars_threshold: z.ZodDefault<z.ZodNumber>;
    promotion_uses_threshold: z.ZodDefault<z.ZodNumber>;
    prune_rejected_after_days: z.ZodDefault<z.ZodNumber>;
    auto_promote_trusted: z.ZodDefault<z.ZodBoolean>;
    auto_promote_score_threshold: z.ZodDefault<z.ZodNumber>;
    circuit_breaker_threshold: z.ZodDefault<z.ZodNumber>;
    circuit_breaker_window_days: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    auto_accept: boolean;
    max_pending: number;
    promotion_stars_threshold: number;
    promotion_uses_threshold: number;
    prune_rejected_after_days: number;
    auto_promote_trusted: boolean;
    auto_promote_score_threshold: number;
    circuit_breaker_threshold: number;
    circuit_breaker_window_days: number;
}, {
    enabled?: boolean | undefined;
    auto_accept?: boolean | undefined;
    max_pending?: number | undefined;
    promotion_stars_threshold?: number | undefined;
    promotion_uses_threshold?: number | undefined;
    prune_rejected_after_days?: number | undefined;
    auto_promote_trusted?: boolean | undefined;
    auto_promote_score_threshold?: number | undefined;
    circuit_breaker_threshold?: number | undefined;
    circuit_breaker_window_days?: number | undefined;
}>;
export declare const GovernanceConfigSchema: z.ZodObject<{
    approval_policy: z.ZodDefault<z.ZodEnum<["none", "review", "strict"]>>;
    curators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    review_sla_hours: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    approval_policy: "strict" | "none" | "review";
    curators: string[];
    review_sla_hours: number;
}, {
    approval_policy?: "strict" | "none" | "review" | undefined;
    curators?: string[] | undefined;
    review_sla_hours?: number | undefined;
}>;
export declare const ReputationConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    visibility: z.ZodDefault<z.ZodEnum<["internal-only", "summary", "full"]>>;
    decay_days: z.ZodDefault<z.ZodNumber>;
    ranking_weight: z.ZodDefault<z.ZodNumber>;
    resume_weight: z.ZodDefault<z.ZodNumber>;
    mcp_exposure: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    visibility: "internal-only" | "summary" | "full";
    enabled: boolean;
    decay_days: number;
    ranking_weight: number;
    resume_weight: number;
    mcp_exposure: boolean;
}, {
    visibility?: "internal-only" | "summary" | "full" | undefined;
    enabled?: boolean | undefined;
    decay_days?: number | undefined;
    ranking_weight?: number | undefined;
    resume_weight?: number | undefined;
    mcp_exposure?: boolean | undefined;
}>;
export type ReputationConfig = z.infer<typeof ReputationConfigSchema>;
export declare const ClaimStatusSchema: z.ZodEnum<["active", "released", "stale"]>;
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;
export declare const ClaimSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    agent: z.ZodString;
    agent_id: z.ZodOptional<z.ZodString>;
    /** OS user who created this claim. */
    user: z.ZodOptional<z.ZodString>;
    project_id: z.ZodOptional<z.ZodString>;
    host_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    scope: z.ZodString;
    description: z.ZodString;
    created_at: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
    plan_id: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["active", "released", "stale"]>;
    released_at: z.ZodOptional<z.ZodString>;
    expires_at: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "active" | "released" | "stale";
    id: string;
    created_at: string;
    scope: string;
    agent: string;
    description: string;
    project?: string | undefined;
    user?: string | undefined;
    schema_version?: number | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    expires_at?: string | undefined;
    plan_id?: string | undefined;
    agent_id?: string | undefined;
    released_at?: string | undefined;
}, {
    status: "active" | "released" | "stale";
    id: string;
    created_at: string;
    scope: string;
    agent: string;
    description: string;
    project?: string | undefined;
    user?: string | undefined;
    schema_version?: number | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    expires_at?: string | undefined;
    plan_id?: string | undefined;
    agent_id?: string | undefined;
    released_at?: string | undefined;
}>;
export type Claim = z.infer<typeof ClaimSchema>;
export declare const RuntimeNoteSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    agent: z.ZodString;
    agent_id: z.ZodOptional<z.ZodString>;
    project_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    created_at: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
    plan_id: z.ZodOptional<z.ZodString>;
    tags: z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
    visibility: z.ZodDefault<z.ZodEnum<["shared", "machine", "private"]>>;
    host_id: z.ZodOptional<z.ZodString>;
    expires_at: z.ZodOptional<z.ZodString>;
    note_type: z.ZodDefault<z.ZodEnum<["observation", "session_start", "session_end"]>>;
    model: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    created_at: string;
    tags: string[];
    visibility: "shared" | "machine" | "private";
    agent: string;
    note_type: "observation" | "session_start" | "session_end";
    project?: string | undefined;
    schema_version?: number | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    expires_at?: string | undefined;
    plan_id?: string | undefined;
    agent_id?: string | undefined;
}, {
    id: string;
    text: string;
    created_at: string;
    agent: string;
    project?: string | undefined;
    schema_version?: number | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    tags?: unknown;
    expires_at?: string | undefined;
    plan_id?: string | undefined;
    visibility?: "shared" | "machine" | "private" | undefined;
    agent_id?: string | undefined;
    note_type?: "observation" | "session_start" | "session_end" | undefined;
}>;
export type RuntimeNote = z.infer<typeof RuntimeNoteSchema>;
export declare const AiSurfaceTaskStatusSchema: z.ZodEnum<["queued", "in_progress", "completed", "cancelled", "failed"]>;
export type AiSurfaceTaskStatus = z.infer<typeof AiSurfaceTaskStatusSchema>;
export declare const AiSurfaceTaskKindSchema: z.ZodEnum<["visual_asset", "draft", "summary", "analysis", "research", "custom"]>;
export type AiSurfaceTaskKind = z.infer<typeof AiSurfaceTaskKindSchema>;
export declare const AiSurfaceTaskRequestSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    short_label: z.ZodOptional<z.ZodString>;
    title: z.ZodString;
    instructions: z.ZodString;
    target_surface: z.ZodString;
    kind: z.ZodDefault<z.ZodEnum<["visual_asset", "draft", "summary", "analysis", "research", "custom"]>>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    author: z.ZodString;
    author_id: z.ZodOptional<z.ZodString>;
    project_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<["queued", "in_progress", "completed", "cancelled", "failed"]>>;
    requested_outputs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    tags: z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodString, "many">>, string[], unknown>;
    claimed_at: z.ZodOptional<z.ZodString>;
    completed_at: z.ZodOptional<z.ZodString>;
    result_note: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "in_progress" | "queued" | "completed" | "cancelled" | "failed";
    id: string;
    created_at: string;
    author: string;
    tags: string[];
    updated_at: string;
    kind: "custom" | "summary" | "visual_asset" | "draft" | "analysis" | "research";
    title: string;
    instructions: string;
    target_surface: string;
    requested_outputs: string[];
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    session_id?: string | undefined;
    related_paths?: string[] | undefined;
    completed_at?: string | undefined;
    claimed_at?: string | undefined;
    result_note?: string | undefined;
}, {
    id: string;
    created_at: string;
    author: string;
    updated_at: string;
    title: string;
    instructions: string;
    target_surface: string;
    status?: "in_progress" | "queued" | "completed" | "cancelled" | "failed" | undefined;
    schema_version?: number | undefined;
    short_label?: string | undefined;
    author_id?: string | undefined;
    model?: string | undefined;
    project_id?: string | undefined;
    session_id?: string | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    completed_at?: string | undefined;
    kind?: "custom" | "summary" | "visual_asset" | "draft" | "analysis" | "research" | undefined;
    requested_outputs?: string[] | undefined;
    claimed_at?: string | undefined;
    result_note?: string | undefined;
}>;
export type AiSurfaceTaskRequest = z.infer<typeof AiSurfaceTaskRequestSchema>;
export declare const RuntimeEventTypeSchema: z.ZodEnum<["task_started", "observation", "risk_detected", "handoff_requested", "task_finished", "session_start", "session_end"]>;
export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>;
export declare const RuntimeEventSchema: z.ZodObject<{
    id: z.ZodString;
    agent: z.ZodString;
    agent_id: z.ZodOptional<z.ZodString>;
    project_id: z.ZodOptional<z.ZodString>;
    host_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    event_type: z.ZodEnum<["task_started", "observation", "risk_detected", "handoff_requested", "task_finished", "session_start", "session_end"]>;
    created_at: z.ZodString;
    text: z.ZodString;
    tags: z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodString, "many">>, string[], unknown>;
    candidate_type: z.ZodOptional<z.ZodEnum<["constraint", "decision", "trap", "handoff"]>>;
    severity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    model: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    created_at: string;
    tags: string[];
    agent: string;
    event_type: "observation" | "session_start" | "session_end" | "task_started" | "risk_detected" | "handoff_requested" | "task_finished";
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    related_paths?: string[] | undefined;
    severity?: "low" | "medium" | "high" | undefined;
    from?: string | undefined;
    to?: string | undefined;
    agent_id?: string | undefined;
    candidate_type?: "constraint" | "decision" | "trap" | "handoff" | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    id: string;
    text: string;
    created_at: string;
    agent: string;
    event_type: "observation" | "session_start" | "session_end" | "task_started" | "risk_detected" | "handoff_requested" | "task_finished";
    model?: string | undefined;
    project_id?: string | undefined;
    host_id?: string | undefined;
    session_id?: string | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    severity?: "low" | "medium" | "high" | undefined;
    from?: string | undefined;
    to?: string | undefined;
    agent_id?: string | undefined;
    candidate_type?: "constraint" | "decision" | "trap" | "handoff" | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
export declare const ProfileSchema: z.ZodEnum<["dev", "openclaw", "ops", "research"]>;
export type Profile = z.infer<typeof ProfileSchema>;
export declare const ProjectModeSchema: z.ZodEnum<["single-project", "multi-project", "auto"]>;
export type ProjectMode = z.infer<typeof ProjectModeSchema>;
export declare const ProjectStrategySchema: z.ZodEnum<["manual", "folder"]>;
export type ProjectStrategy = z.infer<typeof ProjectStrategySchema>;
export declare const TopologyModeSchema: z.ZodEnum<["embedded", "sidecar", "local-only"]>;
export type TopologyMode = z.infer<typeof TopologyModeSchema>;
export declare const IgnoreStrategySchema: z.ZodEnum<["project-gitignore", "none"]>;
export type IgnoreStrategy = z.infer<typeof IgnoreStrategySchema>;
export declare const AgentKindSchema: z.ZodEnum<["agent", "autonomous", "human", "unknown"]>;
export type AgentKind = z.infer<typeof AgentKindSchema>;
export declare const AgentTrustLevelSchema: z.ZodEnum<["observer", "contributor", "trusted", "curator"]>;
export type AgentTrustLevel = z.infer<typeof AgentTrustLevelSchema>;
export declare const AgentIdentityKeySchema: z.ZodObject<{
    algorithm: z.ZodLiteral<"ed25519">;
    public_key: z.ZodString;
    fingerprint: z.ZodString;
    created_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    created_at: string;
    algorithm: "ed25519";
    public_key: string;
    fingerprint: string;
}, {
    created_at: string;
    algorithm: "ed25519";
    public_key: string;
    fingerprint: string;
}>;
export type AgentIdentityKey = z.infer<typeof AgentIdentityKeySchema>;
export declare const ProjectIdentityDocumentSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    version: z.ZodLiteral<1>;
    project_id: z.ZodString;
    project_name: z.ZodString;
    created_at: z.ZodString;
    storage_dir: z.ZodString;
    topology: z.ZodEnum<["embedded", "sidecar", "local-only"]>;
}, "strip", z.ZodTypeAny, {
    created_at: string;
    project_id: string;
    version: 1;
    project_name: string;
    storage_dir: string;
    topology: "embedded" | "sidecar" | "local-only";
    schema_version?: number | undefined;
}, {
    created_at: string;
    project_id: string;
    version: 1;
    project_name: string;
    storage_dir: string;
    topology: "embedded" | "sidecar" | "local-only";
    schema_version?: number | undefined;
}>;
export type ProjectIdentityDocument = z.infer<typeof ProjectIdentityDocumentSchema>;
export declare const AgentIdentityDocumentSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    version: z.ZodLiteral<1>;
    agent_id: z.ZodString;
    agent_name: z.ZodString;
    created_at: z.ZodString;
    kind: z.ZodDefault<z.ZodEnum<["agent", "autonomous", "human", "unknown"]>>;
    trust_level: z.ZodDefault<z.ZodEnum<["observer", "contributor", "trusted", "curator"]>>;
    capabilities: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    identity_key: z.ZodOptional<z.ZodObject<{
        algorithm: z.ZodLiteral<"ed25519">;
        public_key: z.ZodString;
        fingerprint: z.ZodString;
        created_at: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        created_at: string;
        algorithm: "ed25519";
        public_key: string;
        fingerprint: string;
    }, {
        created_at: string;
        algorithm: "ed25519";
        public_key: string;
        fingerprint: string;
    }>>;
    model: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    created_at: string;
    version: 1;
    kind: "unknown" | "agent" | "autonomous" | "human";
    agent_id: string;
    agent_name: string;
    trust_level: "observer" | "contributor" | "trusted" | "curator";
    capabilities: string[];
    schema_version?: number | undefined;
    model?: string | undefined;
    identity_key?: {
        created_at: string;
        algorithm: "ed25519";
        public_key: string;
        fingerprint: string;
    } | undefined;
}, {
    created_at: string;
    version: 1;
    agent_id: string;
    agent_name: string;
    schema_version?: number | undefined;
    model?: string | undefined;
    kind?: "unknown" | "agent" | "autonomous" | "human" | undefined;
    trust_level?: "observer" | "contributor" | "trusted" | "curator" | undefined;
    capabilities?: string[] | undefined;
    identity_key?: {
        created_at: string;
        algorithm: "ed25519";
        public_key: string;
        fingerprint: string;
    } | undefined;
}>;
export type AgentIdentityDocument = z.infer<typeof AgentIdentityDocumentSchema>;
export declare const ProjectsConfigSchema: z.ZodObject<{
    strategy: z.ZodDefault<z.ZodEnum<["manual", "folder"]>>;
    known: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    strategy: "manual" | "folder";
    known: string[];
}, {
    strategy?: "manual" | "folder" | undefined;
    known?: string[] | undefined;
}>;
export type ProjectsConfig = z.infer<typeof ProjectsConfigSchema>;
export declare const RemoteSyncSchema: z.ZodObject<{
    url: z.ZodString;
    provider: z.ZodOptional<z.ZodEnum<["github", "gitlab", "bitbucket", "other"]>>;
    ssh_key_path: z.ZodOptional<z.ZodString>;
    sync_strategy: z.ZodDefault<z.ZodEnum<["pull-only", "push-pull", "pr-based"]>>;
}, "strip", z.ZodTypeAny, {
    url: string;
    sync_strategy: "pull-only" | "push-pull" | "pr-based";
    provider?: "other" | "github" | "gitlab" | "bitbucket" | undefined;
    ssh_key_path?: string | undefined;
}, {
    url: string;
    provider?: "other" | "github" | "gitlab" | "bitbucket" | undefined;
    ssh_key_path?: string | undefined;
    sync_strategy?: "pull-only" | "push-pull" | "pr-based" | undefined;
}>;
export type RemoteSync = z.infer<typeof RemoteSyncSchema>;
export declare const SessionSnapshotSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    session_id: z.ZodString;
    agent: z.ZodString;
    agent_id: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    started_at: z.ZodString;
    context_target: z.ZodOptional<z.ZodString>;
    initial_context_hash: z.ZodOptional<z.ZodString>;
    git_sha: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    session_id: string;
    started_at: string;
    agent: string;
    schema_version?: number | undefined;
    model?: string | undefined;
    agent_id?: string | undefined;
    context_target?: string | undefined;
    initial_context_hash?: string | undefined;
    git_sha?: string | undefined;
}, {
    session_id: string;
    started_at: string;
    agent: string;
    schema_version?: number | undefined;
    model?: string | undefined;
    agent_id?: string | undefined;
    context_target?: string | undefined;
    initial_context_hash?: string | undefined;
    git_sha?: string | undefined;
}>;
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export declare const SessionActiveProjectSchema: z.ZodObject<{
    /** Absolute path to the project directory. */
    path: z.ZodString;
    /** Project name from config.yaml (when available). */
    name: z.ZodOptional<z.ZodString>;
    /** ISO timestamp of the switch. */
    switched_at: z.ZodString;
}, "strict", z.ZodTypeAny, {
    path: string;
    switched_at: string;
    name?: string | undefined;
}, {
    path: string;
    switched_at: string;
    name?: string | undefined;
}>;
export type SessionActiveProject = z.infer<typeof SessionActiveProjectSchema>;
export declare const IsolationModeSchema: z.ZodEnum<["shared-checkout", "dedicated-worktree"]>;
export type IsolationMode = z.infer<typeof IsolationModeSchema>;
export declare const CurrentSessionStateSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    session_id: z.ZodString;
    started_at: z.ZodString;
    last_seen_at: z.ZodString;
    agent: z.ZodString;
    agent_id: z.ZodString;
    host_id: z.ZodString;
    /** OS user who started this session. */
    user: z.ZodOptional<z.ZodString>;
    /** Process ID of the agent process (for liveness detection). */
    pid: z.ZodOptional<z.ZodNumber>;
    /** LLM model used in this session (e.g. "claude-opus-4-6", "gpt-4.1"). */
    model: z.ZodOptional<z.ZodString>;
    /** Session-scoped active project (overrides global active-project.json). */
    active_project: z.ZodOptional<z.ZodObject<{
        /** Absolute path to the project directory. */
        path: z.ZodString;
        /** Project name from config.yaml (when available). */
        name: z.ZodOptional<z.ZodString>;
        /** ISO timestamp of the switch. */
        switched_at: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        path: string;
        switched_at: string;
        name?: string | undefined;
    }, {
        path: string;
        switched_at: string;
        name?: string | undefined;
    }>>;
    /** Git worktree path for this session (undefined = main worktree / shared checkout). */
    worktree_path: z.ZodOptional<z.ZodString>;
    /** Git branch this session is working on. */
    branch: z.ZodOptional<z.ZodString>;
    /** Isolation mode: shared-checkout (default) or dedicated-worktree. */
    isolation_mode: z.ZodOptional<z.ZodEnum<["shared-checkout", "dedicated-worktree"]>>;
}, "strip", z.ZodTypeAny, {
    host_id: string;
    session_id: string;
    started_at: string;
    agent: string;
    agent_id: string;
    last_seen_at: string;
    user?: string | undefined;
    schema_version?: number | undefined;
    model?: string | undefined;
    pid?: number | undefined;
    active_project?: {
        path: string;
        switched_at: string;
        name?: string | undefined;
    } | undefined;
    worktree_path?: string | undefined;
    branch?: string | undefined;
    isolation_mode?: "shared-checkout" | "dedicated-worktree" | undefined;
}, {
    host_id: string;
    session_id: string;
    started_at: string;
    agent: string;
    agent_id: string;
    last_seen_at: string;
    user?: string | undefined;
    schema_version?: number | undefined;
    model?: string | undefined;
    pid?: number | undefined;
    active_project?: {
        path: string;
        switched_at: string;
        name?: string | undefined;
    } | undefined;
    worktree_path?: string | undefined;
    branch?: string | undefined;
    isolation_mode?: "shared-checkout" | "dedicated-worktree" | undefined;
}>;
export type CurrentSessionState = z.infer<typeof CurrentSessionStateSchema>;
export declare const MemorySeedKindSchema: z.ZodEnum<["command", "convention", "entrypoint", "hotspot", "agent_rule", "warning", "environment", "tooling"]>;
export type MemorySeedKind = z.infer<typeof MemorySeedKindSchema>;
export declare const MemorySeedSourceKindSchema: z.ZodEnum<["readme", "agents_md", "native_instruction", "manifest", "repo_analysis", "git", "inference", "machine", "skill", "mcp", "ci_config", "contributing", "changelog", "docker", "env_example", "adr"]>;
export type MemorySeedSourceKind = z.infer<typeof MemorySeedSourceKindSchema>;
export declare const MemorySeedConfidenceSchema: z.ZodEnum<["low", "medium", "high"]>;
export type MemorySeedConfidence = z.infer<typeof MemorySeedConfidenceSchema>;
export declare const MemorySeedDocumentSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    derived_at: z.ZodString;
    text: z.ZodString;
    seed_kind: z.ZodEnum<["command", "convention", "entrypoint", "hotspot", "agent_rule", "warning", "environment", "tooling"]>;
    source_kind: z.ZodEnum<["readme", "agents_md", "native_instruction", "manifest", "repo_analysis", "git", "inference", "machine", "skill", "mcp", "ci_config", "contributing", "changelog", "docker", "env_example", "adr"]>;
    source_ref: z.ZodString;
    confidence: z.ZodEnum<["low", "medium", "high"]>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    tags: z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodString, "many">>, string[], unknown>;
    promotion_hint: z.ZodOptional<z.ZodEnum<["constraint", "decision", "trap"]>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    tags: string[];
    derived_at: string;
    seed_kind: "command" | "convention" | "entrypoint" | "hotspot" | "agent_rule" | "warning" | "environment" | "tooling";
    source_kind: "machine" | "readme" | "agents_md" | "native_instruction" | "manifest" | "repo_analysis" | "git" | "inference" | "skill" | "mcp" | "ci_config" | "contributing" | "changelog" | "docker" | "env_example" | "adr";
    source_ref: string;
    confidence: "low" | "medium" | "high";
    schema_version?: number | undefined;
    related_paths?: string[] | undefined;
    promotion_hint?: "constraint" | "decision" | "trap" | undefined;
}, {
    id: string;
    text: string;
    derived_at: string;
    seed_kind: "command" | "convention" | "entrypoint" | "hotspot" | "agent_rule" | "warning" | "environment" | "tooling";
    source_kind: "machine" | "readme" | "agents_md" | "native_instruction" | "manifest" | "repo_analysis" | "git" | "inference" | "skill" | "mcp" | "ci_config" | "contributing" | "changelog" | "docker" | "env_example" | "adr";
    source_ref: string;
    confidence: "low" | "medium" | "high";
    schema_version?: number | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    promotion_hint?: "constraint" | "decision" | "trap" | undefined;
}>;
export type MemorySeedDocument = z.infer<typeof MemorySeedDocumentSchema>;
export declare const BootstrapProfileDocumentSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    derived_at: z.ZodString;
    repo_fingerprint: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
    sources_scanned: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    git_available: z.ZodDefault<z.ZodBoolean>;
    agents_md_present: z.ZodDefault<z.ZodBoolean>;
    seed_count: z.ZodNumber;
    target: z.ZodOptional<z.ZodString>;
    workspace_kind: z.ZodOptional<z.ZodEnum<["empty", "existing"]>>;
    onboarding_mode: z.ZodOptional<z.ZodEnum<["empty_workspace", "existing_documented", "existing_sparse"]>>;
    confidence: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    native_instruction_files: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    gaps: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    summary: string;
    derived_at: string;
    sources_scanned: string[];
    git_available: boolean;
    agents_md_present: boolean;
    seed_count: number;
    native_instruction_files: string[];
    gaps: string[];
    schema_version?: number | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
    repo_fingerprint?: string | undefined;
    target?: string | undefined;
    workspace_kind?: "empty" | "existing" | undefined;
    onboarding_mode?: "empty_workspace" | "existing_documented" | "existing_sparse" | undefined;
}, {
    summary: string;
    derived_at: string;
    seed_count: number;
    schema_version?: number | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
    repo_fingerprint?: string | undefined;
    sources_scanned?: string[] | undefined;
    git_available?: boolean | undefined;
    agents_md_present?: boolean | undefined;
    target?: string | undefined;
    workspace_kind?: "empty" | "existing" | undefined;
    onboarding_mode?: "empty_workspace" | "existing_documented" | "existing_sparse" | undefined;
    native_instruction_files?: string[] | undefined;
    gaps?: string[] | undefined;
}>;
export type BootstrapProfileDocument = z.infer<typeof BootstrapProfileDocumentSchema>;
export declare const BootstrapSuggestionTargetSchema: z.ZodEnum<["instruction", "decision", "constraint", "trap"]>;
export type BootstrapSuggestionTarget = z.infer<typeof BootstrapSuggestionTargetSchema>;
export declare const BootstrapSuggestionDocumentSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    id: z.ZodString;
    target: z.ZodEnum<["instruction", "decision", "constraint", "trap"]>;
    text: z.ZodString;
    rationale: z.ZodString;
    confidence: z.ZodEnum<["low", "medium", "high"]>;
    source_seed_ids: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    source_refs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    layer: z.ZodOptional<z.ZodEnum<["global", "project", "agent"]>>;
    scope: z.ZodOptional<z.ZodString>;
    tags: z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodString, "many">>, string[], unknown>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    category: z.ZodOptional<z.ZodEnum<["architecture", "performance", "security", "reliability", "compatibility", "process", "other"]>>;
    outcome: z.ZodOptional<z.ZodEnum<["approved", "rejected", "deferred", "pending"]>>;
    severity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    reversible: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    tags: string[];
    confidence: "low" | "medium" | "high";
    target: "constraint" | "decision" | "trap" | "instruction";
    rationale: string;
    source_seed_ids: string[];
    source_refs: string[];
    reversible: boolean;
    schema_version?: number | undefined;
    category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
    scope?: string | undefined;
    related_paths?: string[] | undefined;
    outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
    severity?: "low" | "medium" | "high" | undefined;
    layer?: "project" | "global" | "agent" | undefined;
}, {
    id: string;
    text: string;
    confidence: "low" | "medium" | "high";
    target: "constraint" | "decision" | "trap" | "instruction";
    rationale: string;
    schema_version?: number | undefined;
    category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
    scope?: string | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
    severity?: "low" | "medium" | "high" | undefined;
    layer?: "project" | "global" | "agent" | undefined;
    source_seed_ids?: string[] | undefined;
    source_refs?: string[] | undefined;
    reversible?: boolean | undefined;
}>;
export type BootstrapSuggestionDocument = z.infer<typeof BootstrapSuggestionDocumentSchema>;
export declare const BootstrapInterviewAudienceSchema: z.ZodEnum<["cli", "ide_chat", "any"]>;
export type BootstrapInterviewAudience = z.infer<typeof BootstrapInterviewAudienceSchema>;
export declare const BootstrapInterviewQuestionSchema: z.ZodObject<{
    id: z.ZodString;
    prompt: z.ZodString;
    rationale: z.ZodString;
    priority: z.ZodEnum<["high", "medium", "low"]>;
    audience: z.ZodDefault<z.ZodEnum<["cli", "ide_chat", "any"]>>;
    response_kind: z.ZodDefault<z.ZodEnum<["short_text", "long_text", "boolean", "list"]>>;
    gap_keys: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    target_hints: z.ZodDefault<z.ZodArray<z.ZodEnum<["instruction", "decision", "constraint", "trap"]>, "many">>;
}, "strip", z.ZodTypeAny, {
    id: string;
    priority: "low" | "medium" | "high";
    rationale: string;
    prompt: string;
    audience: "cli" | "ide_chat" | "any";
    response_kind: "boolean" | "short_text" | "long_text" | "list";
    gap_keys: string[];
    target_hints: ("constraint" | "decision" | "trap" | "instruction")[];
}, {
    id: string;
    priority: "low" | "medium" | "high";
    rationale: string;
    prompt: string;
    audience?: "cli" | "ide_chat" | "any" | undefined;
    response_kind?: "boolean" | "short_text" | "long_text" | "list" | undefined;
    gap_keys?: string[] | undefined;
    target_hints?: ("constraint" | "decision" | "trap" | "instruction")[] | undefined;
}>;
export type BootstrapInterviewQuestion = z.infer<typeof BootstrapInterviewQuestionSchema>;
export declare const BootstrapInterviewPlanSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    derived_at: z.ZodString;
    workspace_kind: z.ZodOptional<z.ZodEnum<["empty", "existing"]>>;
    audience: z.ZodDefault<z.ZodEnum<["cli", "ide_chat", "any"]>>;
    summary: z.ZodString;
    question_count: z.ZodNumber;
    questions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        prompt: z.ZodString;
        rationale: z.ZodString;
        priority: z.ZodEnum<["high", "medium", "low"]>;
        audience: z.ZodDefault<z.ZodEnum<["cli", "ide_chat", "any"]>>;
        response_kind: z.ZodDefault<z.ZodEnum<["short_text", "long_text", "boolean", "list"]>>;
        gap_keys: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        target_hints: z.ZodDefault<z.ZodArray<z.ZodEnum<["instruction", "decision", "constraint", "trap"]>, "many">>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        priority: "low" | "medium" | "high";
        rationale: string;
        prompt: string;
        audience: "cli" | "ide_chat" | "any";
        response_kind: "boolean" | "short_text" | "long_text" | "list";
        gap_keys: string[];
        target_hints: ("constraint" | "decision" | "trap" | "instruction")[];
    }, {
        id: string;
        priority: "low" | "medium" | "high";
        rationale: string;
        prompt: string;
        audience?: "cli" | "ide_chat" | "any" | undefined;
        response_kind?: "boolean" | "short_text" | "long_text" | "list" | undefined;
        gap_keys?: string[] | undefined;
        target_hints?: ("constraint" | "decision" | "trap" | "instruction")[] | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    summary: string;
    derived_at: string;
    audience: "cli" | "ide_chat" | "any";
    question_count: number;
    questions: {
        id: string;
        priority: "low" | "medium" | "high";
        rationale: string;
        prompt: string;
        audience: "cli" | "ide_chat" | "any";
        response_kind: "boolean" | "short_text" | "long_text" | "list";
        gap_keys: string[];
        target_hints: ("constraint" | "decision" | "trap" | "instruction")[];
    }[];
    schema_version?: number | undefined;
    workspace_kind?: "empty" | "existing" | undefined;
}, {
    summary: string;
    derived_at: string;
    question_count: number;
    schema_version?: number | undefined;
    workspace_kind?: "empty" | "existing" | undefined;
    audience?: "cli" | "ide_chat" | "any" | undefined;
    questions?: {
        id: string;
        priority: "low" | "medium" | "high";
        rationale: string;
        prompt: string;
        audience?: "cli" | "ide_chat" | "any" | undefined;
        response_kind?: "boolean" | "short_text" | "long_text" | "list" | undefined;
        gap_keys?: string[] | undefined;
        target_hints?: ("constraint" | "decision" | "trap" | "instruction")[] | undefined;
    }[] | undefined;
}>;
export type BootstrapInterviewPlan = z.infer<typeof BootstrapInterviewPlanSchema>;
export declare const BootstrapInterviewAnswerSuggestionSchema: z.ZodObject<{
    target: z.ZodEnum<["instruction", "decision", "constraint", "trap"]>;
    text: z.ZodString;
    rationale: z.ZodOptional<z.ZodString>;
    confidence: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    layer: z.ZodOptional<z.ZodEnum<["global", "project", "agent"]>>;
    scope: z.ZodOptional<z.ZodString>;
    tags: z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodString, "many">>, string[], unknown>;
    related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    category: z.ZodOptional<z.ZodEnum<["architecture", "performance", "security", "reliability", "compatibility", "process", "other"]>>;
    outcome: z.ZodOptional<z.ZodEnum<["approved", "rejected", "deferred", "pending"]>>;
    severity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
}, "strip", z.ZodTypeAny, {
    text: string;
    tags: string[];
    target: "constraint" | "decision" | "trap" | "instruction";
    category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
    scope?: string | undefined;
    related_paths?: string[] | undefined;
    outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
    severity?: "low" | "medium" | "high" | undefined;
    layer?: "project" | "global" | "agent" | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
    rationale?: string | undefined;
}, {
    text: string;
    target: "constraint" | "decision" | "trap" | "instruction";
    category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
    scope?: string | undefined;
    tags?: unknown;
    related_paths?: string[] | undefined;
    outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
    severity?: "low" | "medium" | "high" | undefined;
    layer?: "project" | "global" | "agent" | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
    rationale?: string | undefined;
}>;
export type BootstrapInterviewAnswerSuggestion = z.infer<typeof BootstrapInterviewAnswerSuggestionSchema>;
export declare const BootstrapInterviewAnswerSchema: z.ZodObject<{
    question_id: z.ZodString;
    response_text: z.ZodOptional<z.ZodString>;
    response_items: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    response_boolean: z.ZodOptional<z.ZodBoolean>;
    suggestions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        target: z.ZodEnum<["instruction", "decision", "constraint", "trap"]>;
        text: z.ZodString;
        rationale: z.ZodOptional<z.ZodString>;
        confidence: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
        layer: z.ZodOptional<z.ZodEnum<["global", "project", "agent"]>>;
        scope: z.ZodOptional<z.ZodString>;
        tags: z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodString, "many">>, string[], unknown>;
        related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        category: z.ZodOptional<z.ZodEnum<["architecture", "performance", "security", "reliability", "compatibility", "process", "other"]>>;
        outcome: z.ZodOptional<z.ZodEnum<["approved", "rejected", "deferred", "pending"]>>;
        severity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    }, "strip", z.ZodTypeAny, {
        text: string;
        tags: string[];
        target: "constraint" | "decision" | "trap" | "instruction";
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: string | undefined;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        severity?: "low" | "medium" | "high" | undefined;
        layer?: "project" | "global" | "agent" | undefined;
        confidence?: "low" | "medium" | "high" | undefined;
        rationale?: string | undefined;
    }, {
        text: string;
        target: "constraint" | "decision" | "trap" | "instruction";
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: string | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        severity?: "low" | "medium" | "high" | undefined;
        layer?: "project" | "global" | "agent" | undefined;
        confidence?: "low" | "medium" | "high" | undefined;
        rationale?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    question_id: string;
    response_items: string[];
    suggestions: {
        text: string;
        tags: string[];
        target: "constraint" | "decision" | "trap" | "instruction";
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: string | undefined;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        severity?: "low" | "medium" | "high" | undefined;
        layer?: "project" | "global" | "agent" | undefined;
        confidence?: "low" | "medium" | "high" | undefined;
        rationale?: string | undefined;
    }[];
    response_text?: string | undefined;
    response_boolean?: boolean | undefined;
}, {
    question_id: string;
    response_text?: string | undefined;
    response_items?: string[] | undefined;
    response_boolean?: boolean | undefined;
    suggestions?: {
        text: string;
        target: "constraint" | "decision" | "trap" | "instruction";
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: string | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        severity?: "low" | "medium" | "high" | undefined;
        layer?: "project" | "global" | "agent" | undefined;
        confidence?: "low" | "medium" | "high" | undefined;
        rationale?: string | undefined;
    }[] | undefined;
}>;
export type BootstrapInterviewAnswer = z.infer<typeof BootstrapInterviewAnswerSchema>;
export declare const BootstrapImportPlanDocumentSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    derived_at: z.ZodString;
    target: z.ZodOptional<z.ZodString>;
    workspace_kind: z.ZodOptional<z.ZodEnum<["empty", "existing"]>>;
    onboarding_mode: z.ZodOptional<z.ZodEnum<["empty_workspace", "existing_documented", "existing_sparse"]>>;
    confidence: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    summary: z.ZodString;
    requires_confirmation: z.ZodDefault<z.ZodBoolean>;
    gaps: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    confirmed_suggestion_count: z.ZodDefault<z.ZodNumber>;
    interview_answer_count: z.ZodDefault<z.ZodNumber>;
    suggestion_count: z.ZodNumber;
    suggestions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        schema_version: z.ZodOptional<z.ZodNumber>;
        id: z.ZodString;
        target: z.ZodEnum<["instruction", "decision", "constraint", "trap"]>;
        text: z.ZodString;
        rationale: z.ZodString;
        confidence: z.ZodEnum<["low", "medium", "high"]>;
        source_seed_ids: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        source_refs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        layer: z.ZodOptional<z.ZodEnum<["global", "project", "agent"]>>;
        scope: z.ZodOptional<z.ZodString>;
        tags: z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodString, "many">>, string[], unknown>;
        related_paths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        category: z.ZodOptional<z.ZodEnum<["architecture", "performance", "security", "reliability", "compatibility", "process", "other"]>>;
        outcome: z.ZodOptional<z.ZodEnum<["approved", "rejected", "deferred", "pending"]>>;
        severity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
        reversible: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        tags: string[];
        confidence: "low" | "medium" | "high";
        target: "constraint" | "decision" | "trap" | "instruction";
        rationale: string;
        source_seed_ids: string[];
        source_refs: string[];
        reversible: boolean;
        schema_version?: number | undefined;
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: string | undefined;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        severity?: "low" | "medium" | "high" | undefined;
        layer?: "project" | "global" | "agent" | undefined;
    }, {
        id: string;
        text: string;
        confidence: "low" | "medium" | "high";
        target: "constraint" | "decision" | "trap" | "instruction";
        rationale: string;
        schema_version?: number | undefined;
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: string | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        severity?: "low" | "medium" | "high" | undefined;
        layer?: "project" | "global" | "agent" | undefined;
        source_seed_ids?: string[] | undefined;
        source_refs?: string[] | undefined;
        reversible?: boolean | undefined;
    }>, "many">>;
    interview: z.ZodOptional<z.ZodObject<{
        schema_version: z.ZodOptional<z.ZodNumber>;
        derived_at: z.ZodString;
        workspace_kind: z.ZodOptional<z.ZodEnum<["empty", "existing"]>>;
        audience: z.ZodDefault<z.ZodEnum<["cli", "ide_chat", "any"]>>;
        summary: z.ZodString;
        question_count: z.ZodNumber;
        questions: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            prompt: z.ZodString;
            rationale: z.ZodString;
            priority: z.ZodEnum<["high", "medium", "low"]>;
            audience: z.ZodDefault<z.ZodEnum<["cli", "ide_chat", "any"]>>;
            response_kind: z.ZodDefault<z.ZodEnum<["short_text", "long_text", "boolean", "list"]>>;
            gap_keys: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            target_hints: z.ZodDefault<z.ZodArray<z.ZodEnum<["instruction", "decision", "constraint", "trap"]>, "many">>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            priority: "low" | "medium" | "high";
            rationale: string;
            prompt: string;
            audience: "cli" | "ide_chat" | "any";
            response_kind: "boolean" | "short_text" | "long_text" | "list";
            gap_keys: string[];
            target_hints: ("constraint" | "decision" | "trap" | "instruction")[];
        }, {
            id: string;
            priority: "low" | "medium" | "high";
            rationale: string;
            prompt: string;
            audience?: "cli" | "ide_chat" | "any" | undefined;
            response_kind?: "boolean" | "short_text" | "long_text" | "list" | undefined;
            gap_keys?: string[] | undefined;
            target_hints?: ("constraint" | "decision" | "trap" | "instruction")[] | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        summary: string;
        derived_at: string;
        audience: "cli" | "ide_chat" | "any";
        question_count: number;
        questions: {
            id: string;
            priority: "low" | "medium" | "high";
            rationale: string;
            prompt: string;
            audience: "cli" | "ide_chat" | "any";
            response_kind: "boolean" | "short_text" | "long_text" | "list";
            gap_keys: string[];
            target_hints: ("constraint" | "decision" | "trap" | "instruction")[];
        }[];
        schema_version?: number | undefined;
        workspace_kind?: "empty" | "existing" | undefined;
    }, {
        summary: string;
        derived_at: string;
        question_count: number;
        schema_version?: number | undefined;
        workspace_kind?: "empty" | "existing" | undefined;
        audience?: "cli" | "ide_chat" | "any" | undefined;
        questions?: {
            id: string;
            priority: "low" | "medium" | "high";
            rationale: string;
            prompt: string;
            audience?: "cli" | "ide_chat" | "any" | undefined;
            response_kind?: "boolean" | "short_text" | "long_text" | "list" | undefined;
            gap_keys?: string[] | undefined;
            target_hints?: ("constraint" | "decision" | "trap" | "instruction")[] | undefined;
        }[] | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    summary: string;
    derived_at: string;
    gaps: string[];
    suggestions: {
        id: string;
        text: string;
        tags: string[];
        confidence: "low" | "medium" | "high";
        target: "constraint" | "decision" | "trap" | "instruction";
        rationale: string;
        source_seed_ids: string[];
        source_refs: string[];
        reversible: boolean;
        schema_version?: number | undefined;
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: string | undefined;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        severity?: "low" | "medium" | "high" | undefined;
        layer?: "project" | "global" | "agent" | undefined;
    }[];
    requires_confirmation: boolean;
    confirmed_suggestion_count: number;
    interview_answer_count: number;
    suggestion_count: number;
    schema_version?: number | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
    target?: string | undefined;
    workspace_kind?: "empty" | "existing" | undefined;
    onboarding_mode?: "empty_workspace" | "existing_documented" | "existing_sparse" | undefined;
    interview?: {
        summary: string;
        derived_at: string;
        audience: "cli" | "ide_chat" | "any";
        question_count: number;
        questions: {
            id: string;
            priority: "low" | "medium" | "high";
            rationale: string;
            prompt: string;
            audience: "cli" | "ide_chat" | "any";
            response_kind: "boolean" | "short_text" | "long_text" | "list";
            gap_keys: string[];
            target_hints: ("constraint" | "decision" | "trap" | "instruction")[];
        }[];
        schema_version?: number | undefined;
        workspace_kind?: "empty" | "existing" | undefined;
    } | undefined;
}, {
    summary: string;
    derived_at: string;
    suggestion_count: number;
    schema_version?: number | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
    target?: string | undefined;
    workspace_kind?: "empty" | "existing" | undefined;
    onboarding_mode?: "empty_workspace" | "existing_documented" | "existing_sparse" | undefined;
    gaps?: string[] | undefined;
    suggestions?: {
        id: string;
        text: string;
        confidence: "low" | "medium" | "high";
        target: "constraint" | "decision" | "trap" | "instruction";
        rationale: string;
        schema_version?: number | undefined;
        category?: "architecture" | "performance" | "security" | "reliability" | "compatibility" | "process" | "other" | undefined;
        scope?: string | undefined;
        tags?: unknown;
        related_paths?: string[] | undefined;
        outcome?: "approved" | "rejected" | "deferred" | "pending" | undefined;
        severity?: "low" | "medium" | "high" | undefined;
        layer?: "project" | "global" | "agent" | undefined;
        source_seed_ids?: string[] | undefined;
        source_refs?: string[] | undefined;
        reversible?: boolean | undefined;
    }[] | undefined;
    requires_confirmation?: boolean | undefined;
    confirmed_suggestion_count?: number | undefined;
    interview_answer_count?: number | undefined;
    interview?: {
        summary: string;
        derived_at: string;
        question_count: number;
        schema_version?: number | undefined;
        workspace_kind?: "empty" | "existing" | undefined;
        audience?: "cli" | "ide_chat" | "any" | undefined;
        questions?: {
            id: string;
            priority: "low" | "medium" | "high";
            rationale: string;
            prompt: string;
            audience?: "cli" | "ide_chat" | "any" | undefined;
            response_kind?: "boolean" | "short_text" | "long_text" | "list" | undefined;
            gap_keys?: string[] | undefined;
            target_hints?: ("constraint" | "decision" | "trap" | "instruction")[] | undefined;
        }[] | undefined;
    } | undefined;
}>;
export type BootstrapImportPlanDocument = z.infer<typeof BootstrapImportPlanDocumentSchema>;
export declare const BootstrapManagedArtifactSchema: z.ZodObject<{
    kind: z.ZodEnum<["instruction", "decision", "constraint", "trap"]>;
    id: z.ZodString;
    suggestion_id: z.ZodString;
    rollback_action: z.ZodDefault<z.ZodEnum<["deactivate", "delete"]>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    kind: "constraint" | "decision" | "trap" | "instruction";
    suggestion_id: string;
    rollback_action: "deactivate" | "delete";
}, {
    id: string;
    kind: "constraint" | "decision" | "trap" | "instruction";
    suggestion_id: string;
    rollback_action?: "deactivate" | "delete" | undefined;
}>;
export type BootstrapManagedArtifact = z.infer<typeof BootstrapManagedArtifactSchema>;
export declare const BootstrapApplicationReceiptSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    applied_at: z.ZodString;
    proposal_derived_at: z.ZodString;
    target: z.ZodOptional<z.ZodString>;
    workspace_kind: z.ZodOptional<z.ZodEnum<["empty", "existing"]>>;
    managed_artifacts: z.ZodDefault<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<["instruction", "decision", "constraint", "trap"]>;
        id: z.ZodString;
        suggestion_id: z.ZodString;
        rollback_action: z.ZodDefault<z.ZodEnum<["deactivate", "delete"]>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        kind: "constraint" | "decision" | "trap" | "instruction";
        suggestion_id: string;
        rollback_action: "deactivate" | "delete";
    }, {
        id: string;
        kind: "constraint" | "decision" | "trap" | "instruction";
        suggestion_id: string;
        rollback_action?: "deactivate" | "delete" | undefined;
    }>, "many">>;
    suggestion_ids: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    uninstalled_at: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    applied_at: string;
    proposal_derived_at: string;
    managed_artifacts: {
        id: string;
        kind: "constraint" | "decision" | "trap" | "instruction";
        suggestion_id: string;
        rollback_action: "deactivate" | "delete";
    }[];
    suggestion_ids: string[];
    schema_version?: number | undefined;
    target?: string | undefined;
    workspace_kind?: "empty" | "existing" | undefined;
    uninstalled_at?: string | undefined;
}, {
    applied_at: string;
    proposal_derived_at: string;
    schema_version?: number | undefined;
    target?: string | undefined;
    workspace_kind?: "empty" | "existing" | undefined;
    managed_artifacts?: {
        id: string;
        kind: "constraint" | "decision" | "trap" | "instruction";
        suggestion_id: string;
        rollback_action?: "deactivate" | "delete" | undefined;
    }[] | undefined;
    suggestion_ids?: string[] | undefined;
    uninstalled_at?: string | undefined;
}>;
export type BootstrapApplicationReceipt = z.infer<typeof BootstrapApplicationReceiptSchema>;
export declare const AgentIntegrationNameSchema: z.ZodEnum<["github-copilot", "claude-code", "cursor", "windsurf", "cline", "codex", "opencode", "antigravity", "continue", "roo", "openclaw", "nanoclaw", "nemoclaw", "picoclaw", "zeroclaw"]>;
export type AgentIntegrationName = z.infer<typeof AgentIntegrationNameSchema>;
export declare const AgentIntegrationSurfaceKindSchema: z.ZodEnum<["instructions", "mcp", "skill", "rule", "hook"]>;
export type AgentIntegrationSurfaceKind = z.infer<typeof AgentIntegrationSurfaceKindSchema>;
export declare const AgentIntegrationLocationSchema: z.ZodEnum<["workspace", "machine"]>;
export type AgentIntegrationLocation = z.infer<typeof AgentIntegrationLocationSchema>;
export declare const AgentIntegrationDeclarationSourceSchema: z.ZodEnum<["manual", "detected"]>;
export type AgentIntegrationDeclarationSource = z.infer<typeof AgentIntegrationDeclarationSourceSchema>;
export declare const AgentIntegrationSurfaceSchema: z.ZodObject<{
    kind: z.ZodEnum<["instructions", "mcp", "skill", "rule", "hook"]>;
    location: z.ZodEnum<["workspace", "machine"]>;
    path: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
    location: "machine" | "workspace";
    path?: string | undefined;
}, {
    kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
    location: "machine" | "workspace";
    path?: string | undefined;
}>;
export type AgentIntegrationSurface = z.infer<typeof AgentIntegrationSurfaceSchema>;
export declare const AgentIntegrationLevelSchema: z.ZodEnum<["full", "standard", "limited", "custom"]>;
export type AgentIntegrationLevel = z.infer<typeof AgentIntegrationLevelSchema>;
export declare const AgentIntegrationDeclarationSchema: z.ZodObject<{
    agent_name: z.ZodEnum<["github-copilot", "claude-code", "cursor", "windsurf", "cline", "codex", "opencode", "antigravity", "continue", "roo", "openclaw", "nanoclaw", "nemoclaw", "picoclaw", "zeroclaw"]>;
    declaration_source: z.ZodDefault<z.ZodEnum<["manual", "detected"]>>;
    level: z.ZodOptional<z.ZodEnum<["full", "standard", "limited", "custom"]>>;
    surfaces: z.ZodDefault<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<["instructions", "mcp", "skill", "rule", "hook"]>;
        location: z.ZodEnum<["workspace", "machine"]>;
        path: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
        location: "machine" | "workspace";
        path?: string | undefined;
    }, {
        kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
        location: "machine" | "workspace";
        path?: string | undefined;
    }>, "many">>;
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
    declaration_source: "manual" | "detected";
    surfaces: {
        kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
        location: "machine" | "workspace";
        path?: string | undefined;
    }[];
    level?: "custom" | "full" | "standard" | "limited" | undefined;
    notes?: string | undefined;
}, {
    agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
    declaration_source?: "manual" | "detected" | undefined;
    level?: "custom" | "full" | "standard" | "limited" | undefined;
    surfaces?: {
        kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
        location: "machine" | "workspace";
        path?: string | undefined;
    }[] | undefined;
    notes?: string | undefined;
}>;
export type AgentIntegrationDeclaration = z.infer<typeof AgentIntegrationDeclarationSchema>;
export declare const AgentIntegrationsConfigSchema: z.ZodObject<{
    declarations: z.ZodDefault<z.ZodArray<z.ZodObject<{
        agent_name: z.ZodEnum<["github-copilot", "claude-code", "cursor", "windsurf", "cline", "codex", "opencode", "antigravity", "continue", "roo", "openclaw", "nanoclaw", "nemoclaw", "picoclaw", "zeroclaw"]>;
        declaration_source: z.ZodDefault<z.ZodEnum<["manual", "detected"]>>;
        level: z.ZodOptional<z.ZodEnum<["full", "standard", "limited", "custom"]>>;
        surfaces: z.ZodDefault<z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<["instructions", "mcp", "skill", "rule", "hook"]>;
            location: z.ZodEnum<["workspace", "machine"]>;
            path: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
            location: "machine" | "workspace";
            path?: string | undefined;
        }, {
            kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
            location: "machine" | "workspace";
            path?: string | undefined;
        }>, "many">>;
        notes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
        declaration_source: "manual" | "detected";
        surfaces: {
            kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
            location: "machine" | "workspace";
            path?: string | undefined;
        }[];
        level?: "custom" | "full" | "standard" | "limited" | undefined;
        notes?: string | undefined;
    }, {
        agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
        declaration_source?: "manual" | "detected" | undefined;
        level?: "custom" | "full" | "standard" | "limited" | undefined;
        surfaces?: {
            kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
            location: "machine" | "workspace";
            path?: string | undefined;
        }[] | undefined;
        notes?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    declarations: {
        agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
        declaration_source: "manual" | "detected";
        surfaces: {
            kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
            location: "machine" | "workspace";
            path?: string | undefined;
        }[];
        level?: "custom" | "full" | "standard" | "limited" | undefined;
        notes?: string | undefined;
    }[];
}, {
    declarations?: {
        agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
        declaration_source?: "manual" | "detected" | undefined;
        level?: "custom" | "full" | "standard" | "limited" | undefined;
        surfaces?: {
            kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
            location: "machine" | "workspace";
            path?: string | undefined;
        }[] | undefined;
        notes?: string | undefined;
    }[] | undefined;
}>;
export type AgentIntegrationsConfig = z.infer<typeof AgentIntegrationsConfigSchema>;
export declare const CrossProjectLinkSchema: z.ZodObject<{
    path: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    role: z.ZodDefault<z.ZodEnum<["subscriber", "publisher"]>>;
}, "strip", z.ZodTypeAny, {
    path: string;
    role: "subscriber" | "publisher";
    name?: string | undefined;
}, {
    path: string;
    name?: string | undefined;
    role?: "subscriber" | "publisher" | undefined;
}>;
export type CrossProjectLink = z.infer<typeof CrossProjectLinkSchema>;
export declare const BrainclawUpdateSourceLocalPackSchema: z.ZodObject<{
    type: z.ZodLiteral<"local-pack">;
    manifest_path: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "local-pack";
    manifest_path: string;
}, {
    type: "local-pack";
    manifest_path: string;
}>;
export type BrainclawUpdateSourceLocalPack = z.infer<typeof BrainclawUpdateSourceLocalPackSchema>;
export declare const BrainclawUpdateSourceNpmSchema: z.ZodObject<{
    type: z.ZodLiteral<"npm">;
    package_name: z.ZodDefault<z.ZodString>;
    dist_tag: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "npm";
    package_name: string;
    dist_tag: string;
}, {
    type: "npm";
    package_name?: string | undefined;
    dist_tag?: string | undefined;
}>;
export type BrainclawUpdateSourceNpm = z.infer<typeof BrainclawUpdateSourceNpmSchema>;
export declare const BrainclawUpdateSourceSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"local-pack">;
    manifest_path: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "local-pack";
    manifest_path: string;
}, {
    type: "local-pack";
    manifest_path: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"npm">;
    package_name: z.ZodDefault<z.ZodString>;
    dist_tag: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "npm";
    package_name: string;
    dist_tag: string;
}, {
    type: "npm";
    package_name?: string | undefined;
    dist_tag?: string | undefined;
}>]>;
export type BrainclawUpdateSource = z.infer<typeof BrainclawUpdateSourceSchema>;
export declare const BrainclawLocalReleaseManifestSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    version: z.ZodLiteral<1>;
    channel: z.ZodDefault<z.ZodLiteral<"local-pack">>;
    package_name: z.ZodDefault<z.ZodString>;
    latest_installable_version: z.ZodString;
    published_at: z.ZodOptional<z.ZodString>;
    artifact_path: z.ZodOptional<z.ZodString>;
    install_command: z.ZodOptional<z.ZodString>;
    release_notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    version: 1;
    package_name: string;
    channel: "local-pack";
    latest_installable_version: string;
    schema_version?: number | undefined;
    published_at?: string | undefined;
    artifact_path?: string | undefined;
    install_command?: string | undefined;
    release_notes?: string | undefined;
}, {
    version: 1;
    latest_installable_version: string;
    schema_version?: number | undefined;
    package_name?: string | undefined;
    channel?: "local-pack" | undefined;
    published_at?: string | undefined;
    artifact_path?: string | undefined;
    install_command?: string | undefined;
    release_notes?: string | undefined;
}>;
export type BrainclawLocalReleaseManifest = z.infer<typeof BrainclawLocalReleaseManifestSchema>;
export declare const ConfigSchema: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodNumber>;
    version: z.ZodLiteral<1>;
    project_name: z.ZodString;
    project_id: z.ZodOptional<z.ZodString>;
    minimum_brainclaw_version: z.ZodOptional<z.ZodString>;
    recommended_brainclaw_version: z.ZodOptional<z.ZodString>;
    brainclaw_upgrade_message: z.ZodOptional<z.ZodString>;
    brainclaw_upgrade_command: z.ZodOptional<z.ZodString>;
    brainclaw_update_source: z.ZodOptional<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"local-pack">;
        manifest_path: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "local-pack";
        manifest_path: string;
    }, {
        type: "local-pack";
        manifest_path: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"npm">;
        package_name: z.ZodDefault<z.ZodString>;
        dist_tag: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "npm";
        package_name: string;
        dist_tag: string;
    }, {
        type: "npm";
        package_name?: string | undefined;
        dist_tag?: string | undefined;
    }>]>>;
    current_agent: z.ZodOptional<z.ZodString>;
    current_agent_id: z.ZodOptional<z.ZodString>;
    storage_dir: z.ZodDefault<z.ZodString>;
    topology: z.ZodDefault<z.ZodEnum<["embedded", "sidecar", "local-only"]>>;
    ignore_strategy: z.ZodDefault<z.ZodEnum<["project-gitignore", "none"]>>;
    project_mode: z.ZodDefault<z.ZodEnum<["single-project", "multi-project", "auto"]>>;
    projects: z.ZodDefault<z.ZodObject<{
        strategy: z.ZodDefault<z.ZodEnum<["manual", "folder"]>>;
        known: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        strategy: "manual" | "folder";
        known: string[];
    }, {
        strategy?: "manual" | "folder" | undefined;
        known?: string[] | undefined;
    }>>;
    profile: z.ZodOptional<z.ZodEnum<["dev", "openclaw", "ops", "research"]>>;
    target_audience: z.ZodDefault<z.ZodOptional<z.ZodEnum<["human", "agent"]>>>;
    openclaw_bridge: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    remote_sync: z.ZodOptional<z.ZodObject<{
        url: z.ZodString;
        provider: z.ZodOptional<z.ZodEnum<["github", "gitlab", "bitbucket", "other"]>>;
        ssh_key_path: z.ZodOptional<z.ZodString>;
        sync_strategy: z.ZodDefault<z.ZodEnum<["pull-only", "push-pull", "pr-based"]>>;
    }, "strip", z.ZodTypeAny, {
        url: string;
        sync_strategy: "pull-only" | "push-pull" | "pr-based";
        provider?: "other" | "github" | "gitlab" | "bitbucket" | undefined;
        ssh_key_path?: string | undefined;
    }, {
        url: string;
        provider?: "other" | "github" | "gitlab" | "bitbucket" | undefined;
        ssh_key_path?: string | undefined;
        sync_strategy?: "pull-only" | "push-pull" | "pr-based" | undefined;
    }>>;
    telemetry: z.ZodLiteral<false>;
    allow_network: z.ZodLiteral<false>;
    redaction: z.ZodObject<{
        enabled: z.ZodBoolean;
        patterns: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        patterns: string[];
    }, {
        enabled: boolean;
        patterns: string[];
    }>;
    sensitive_paths: z.ZodArray<z.ZodString, "many">;
    security: z.ZodOptional<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<["warn", "strict"]>>;
        strict_redaction: z.ZodDefault<z.ZodBoolean>;
        block_sensitive_paths: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        mode: "warn" | "strict";
        strict_redaction: boolean;
        block_sensitive_paths: boolean;
    }, {
        mode?: "warn" | "strict" | undefined;
        strict_redaction?: boolean | undefined;
        block_sensitive_paths?: boolean | undefined;
    }>>;
    markdown: z.ZodOptional<z.ZodObject<{
        max_items_per_section: z.ZodDefault<z.ZodNumber>;
        compact_mode: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        max_items_per_section: number;
        compact_mode: boolean;
    }, {
        max_items_per_section?: number | undefined;
        compact_mode?: boolean | undefined;
    }>>;
    reflective_memory: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        auto_accept: z.ZodDefault<z.ZodBoolean>;
        max_pending: z.ZodDefault<z.ZodNumber>;
        promotion_stars_threshold: z.ZodDefault<z.ZodNumber>;
        promotion_uses_threshold: z.ZodDefault<z.ZodNumber>;
        prune_rejected_after_days: z.ZodDefault<z.ZodNumber>;
        auto_promote_trusted: z.ZodDefault<z.ZodBoolean>;
        auto_promote_score_threshold: z.ZodDefault<z.ZodNumber>;
        circuit_breaker_threshold: z.ZodDefault<z.ZodNumber>;
        circuit_breaker_window_days: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        auto_accept: boolean;
        max_pending: number;
        promotion_stars_threshold: number;
        promotion_uses_threshold: number;
        prune_rejected_after_days: number;
        auto_promote_trusted: boolean;
        auto_promote_score_threshold: number;
        circuit_breaker_threshold: number;
        circuit_breaker_window_days: number;
    }, {
        enabled?: boolean | undefined;
        auto_accept?: boolean | undefined;
        max_pending?: number | undefined;
        promotion_stars_threshold?: number | undefined;
        promotion_uses_threshold?: number | undefined;
        prune_rejected_after_days?: number | undefined;
        auto_promote_trusted?: boolean | undefined;
        auto_promote_score_threshold?: number | undefined;
        circuit_breaker_threshold?: number | undefined;
        circuit_breaker_window_days?: number | undefined;
    }>>;
    governance: z.ZodOptional<z.ZodObject<{
        approval_policy: z.ZodDefault<z.ZodEnum<["none", "review", "strict"]>>;
        curators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        review_sla_hours: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        approval_policy: "strict" | "none" | "review";
        curators: string[];
        review_sla_hours: number;
    }, {
        approval_policy?: "strict" | "none" | "review" | undefined;
        curators?: string[] | undefined;
        review_sla_hours?: number | undefined;
    }>>;
    reputation: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        visibility: z.ZodDefault<z.ZodEnum<["internal-only", "summary", "full"]>>;
        decay_days: z.ZodDefault<z.ZodNumber>;
        ranking_weight: z.ZodDefault<z.ZodNumber>;
        resume_weight: z.ZodDefault<z.ZodNumber>;
        mcp_exposure: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        visibility: "internal-only" | "summary" | "full";
        enabled: boolean;
        decay_days: number;
        ranking_weight: number;
        resume_weight: number;
        mcp_exposure: boolean;
    }, {
        visibility?: "internal-only" | "summary" | "full" | undefined;
        enabled?: boolean | undefined;
        decay_days?: number | undefined;
        ranking_weight?: number | undefined;
        resume_weight?: number | undefined;
        mcp_exposure?: boolean | undefined;
    }>>;
    agent_integrations: z.ZodDefault<z.ZodObject<{
        declarations: z.ZodDefault<z.ZodArray<z.ZodObject<{
            agent_name: z.ZodEnum<["github-copilot", "claude-code", "cursor", "windsurf", "cline", "codex", "opencode", "antigravity", "continue", "roo", "openclaw", "nanoclaw", "nemoclaw", "picoclaw", "zeroclaw"]>;
            declaration_source: z.ZodDefault<z.ZodEnum<["manual", "detected"]>>;
            level: z.ZodOptional<z.ZodEnum<["full", "standard", "limited", "custom"]>>;
            surfaces: z.ZodDefault<z.ZodArray<z.ZodObject<{
                kind: z.ZodEnum<["instructions", "mcp", "skill", "rule", "hook"]>;
                location: z.ZodEnum<["workspace", "machine"]>;
                path: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
                location: "machine" | "workspace";
                path?: string | undefined;
            }, {
                kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
                location: "machine" | "workspace";
                path?: string | undefined;
            }>, "many">>;
            notes: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
            declaration_source: "manual" | "detected";
            surfaces: {
                kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
                location: "machine" | "workspace";
                path?: string | undefined;
            }[];
            level?: "custom" | "full" | "standard" | "limited" | undefined;
            notes?: string | undefined;
        }, {
            agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
            declaration_source?: "manual" | "detected" | undefined;
            level?: "custom" | "full" | "standard" | "limited" | undefined;
            surfaces?: {
                kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
                location: "machine" | "workspace";
                path?: string | undefined;
            }[] | undefined;
            notes?: string | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        declarations: {
            agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
            declaration_source: "manual" | "detected";
            surfaces: {
                kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
                location: "machine" | "workspace";
                path?: string | undefined;
            }[];
            level?: "custom" | "full" | "standard" | "limited" | undefined;
            notes?: string | undefined;
        }[];
    }, {
        declarations?: {
            agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
            declaration_source?: "manual" | "detected" | undefined;
            level?: "custom" | "full" | "standard" | "limited" | undefined;
            surfaces?: {
                kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
                location: "machine" | "workspace";
                path?: string | undefined;
            }[] | undefined;
            notes?: string | undefined;
        }[] | undefined;
    }>>;
    cross_project_links: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        role: z.ZodDefault<z.ZodEnum<["subscriber", "publisher"]>>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        role: "subscriber" | "publisher";
        name?: string | undefined;
    }, {
        path: string;
        name?: string | undefined;
        role?: "subscriber" | "publisher" | undefined;
    }>, "many">>>;
    implicit_session_ttl: z.ZodDefault<z.ZodString>;
    auto_reflect_notes: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    version: 1;
    project_name: string;
    storage_dir: string;
    topology: "embedded" | "sidecar" | "local-only";
    ignore_strategy: "none" | "project-gitignore";
    project_mode: "single-project" | "multi-project" | "auto";
    projects: {
        strategy: "manual" | "folder";
        known: string[];
    };
    target_audience: "agent" | "human";
    openclaw_bridge: boolean;
    telemetry: false;
    allow_network: false;
    redaction: {
        enabled: boolean;
        patterns: string[];
    };
    sensitive_paths: string[];
    agent_integrations: {
        declarations: {
            agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
            declaration_source: "manual" | "detected";
            surfaces: {
                kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
                location: "machine" | "workspace";
                path?: string | undefined;
            }[];
            level?: "custom" | "full" | "standard" | "limited" | undefined;
            notes?: string | undefined;
        }[];
    };
    cross_project_links: {
        path: string;
        role: "subscriber" | "publisher";
        name?: string | undefined;
    }[];
    implicit_session_ttl: string;
    auto_reflect_notes: boolean;
    security?: {
        mode: "warn" | "strict";
        strict_redaction: boolean;
        block_sensitive_paths: boolean;
    } | undefined;
    schema_version?: number | undefined;
    project_id?: string | undefined;
    minimum_brainclaw_version?: string | undefined;
    recommended_brainclaw_version?: string | undefined;
    brainclaw_upgrade_message?: string | undefined;
    brainclaw_upgrade_command?: string | undefined;
    brainclaw_update_source?: {
        type: "local-pack";
        manifest_path: string;
    } | {
        type: "npm";
        package_name: string;
        dist_tag: string;
    } | undefined;
    current_agent?: string | undefined;
    current_agent_id?: string | undefined;
    profile?: "research" | "dev" | "openclaw" | "ops" | undefined;
    remote_sync?: {
        url: string;
        sync_strategy: "pull-only" | "push-pull" | "pr-based";
        provider?: "other" | "github" | "gitlab" | "bitbucket" | undefined;
        ssh_key_path?: string | undefined;
    } | undefined;
    markdown?: {
        max_items_per_section: number;
        compact_mode: boolean;
    } | undefined;
    reflective_memory?: {
        enabled: boolean;
        auto_accept: boolean;
        max_pending: number;
        promotion_stars_threshold: number;
        promotion_uses_threshold: number;
        prune_rejected_after_days: number;
        auto_promote_trusted: boolean;
        auto_promote_score_threshold: number;
        circuit_breaker_threshold: number;
        circuit_breaker_window_days: number;
    } | undefined;
    governance?: {
        approval_policy: "strict" | "none" | "review";
        curators: string[];
        review_sla_hours: number;
    } | undefined;
    reputation?: {
        visibility: "internal-only" | "summary" | "full";
        enabled: boolean;
        decay_days: number;
        ranking_weight: number;
        resume_weight: number;
        mcp_exposure: boolean;
    } | undefined;
}, {
    version: 1;
    project_name: string;
    telemetry: false;
    allow_network: false;
    redaction: {
        enabled: boolean;
        patterns: string[];
    };
    sensitive_paths: string[];
    security?: {
        mode?: "warn" | "strict" | undefined;
        strict_redaction?: boolean | undefined;
        block_sensitive_paths?: boolean | undefined;
    } | undefined;
    schema_version?: number | undefined;
    project_id?: string | undefined;
    storage_dir?: string | undefined;
    topology?: "embedded" | "sidecar" | "local-only" | undefined;
    minimum_brainclaw_version?: string | undefined;
    recommended_brainclaw_version?: string | undefined;
    brainclaw_upgrade_message?: string | undefined;
    brainclaw_upgrade_command?: string | undefined;
    brainclaw_update_source?: {
        type: "local-pack";
        manifest_path: string;
    } | {
        type: "npm";
        package_name?: string | undefined;
        dist_tag?: string | undefined;
    } | undefined;
    current_agent?: string | undefined;
    current_agent_id?: string | undefined;
    ignore_strategy?: "none" | "project-gitignore" | undefined;
    project_mode?: "single-project" | "multi-project" | "auto" | undefined;
    projects?: {
        strategy?: "manual" | "folder" | undefined;
        known?: string[] | undefined;
    } | undefined;
    profile?: "research" | "dev" | "openclaw" | "ops" | undefined;
    target_audience?: "agent" | "human" | undefined;
    openclaw_bridge?: boolean | undefined;
    remote_sync?: {
        url: string;
        provider?: "other" | "github" | "gitlab" | "bitbucket" | undefined;
        ssh_key_path?: string | undefined;
        sync_strategy?: "pull-only" | "push-pull" | "pr-based" | undefined;
    } | undefined;
    markdown?: {
        max_items_per_section?: number | undefined;
        compact_mode?: boolean | undefined;
    } | undefined;
    reflective_memory?: {
        enabled?: boolean | undefined;
        auto_accept?: boolean | undefined;
        max_pending?: number | undefined;
        promotion_stars_threshold?: number | undefined;
        promotion_uses_threshold?: number | undefined;
        prune_rejected_after_days?: number | undefined;
        auto_promote_trusted?: boolean | undefined;
        auto_promote_score_threshold?: number | undefined;
        circuit_breaker_threshold?: number | undefined;
        circuit_breaker_window_days?: number | undefined;
    } | undefined;
    governance?: {
        approval_policy?: "strict" | "none" | "review" | undefined;
        curators?: string[] | undefined;
        review_sla_hours?: number | undefined;
    } | undefined;
    reputation?: {
        visibility?: "internal-only" | "summary" | "full" | undefined;
        enabled?: boolean | undefined;
        decay_days?: number | undefined;
        ranking_weight?: number | undefined;
        resume_weight?: number | undefined;
        mcp_exposure?: boolean | undefined;
    } | undefined;
    agent_integrations?: {
        declarations?: {
            agent_name: "openclaw" | "github-copilot" | "claude-code" | "cursor" | "windsurf" | "cline" | "codex" | "opencode" | "antigravity" | "continue" | "roo" | "nanoclaw" | "nemoclaw" | "picoclaw" | "zeroclaw";
            declaration_source?: "manual" | "detected" | undefined;
            level?: "custom" | "full" | "standard" | "limited" | undefined;
            surfaces?: {
                kind: "instructions" | "skill" | "mcp" | "rule" | "hook";
                location: "machine" | "workspace";
                path?: string | undefined;
            }[] | undefined;
            notes?: string | undefined;
        }[] | undefined;
    } | undefined;
    cross_project_links?: {
        path: string;
        name?: string | undefined;
        role?: "subscriber" | "publisher" | undefined;
    }[] | undefined;
    implicit_session_ttl?: string | undefined;
    auto_reflect_notes?: boolean | undefined;
}>;
export type Config = z.infer<typeof ConfigSchema>;
//# sourceMappingURL=schema.d.ts.map