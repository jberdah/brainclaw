# Standardization Analysis: What's Already Working + Gaps

## Part 1: What Brainclaw Already Does Right

### ✅ Memory CRUD (v0.14)
- **Items**: Constraint, Decision, Trap, Instruction, Plan, Claim, Handoff, RuntimeNote, Candidate
- **CRUD Operations**: Create, Read, Update, Delete all implemented
- **Multi-level Scope**: local → repo → workspace → user
- **Audit Trail**: Every mutation logged
- **Search**: Full-text BM25 across all items
- **Trust Levels**: contributor, trusted, curator with permission gates
- **Context Merging**: Automatic merge from all store levels

**Why This Works**:
- Items are immutable at root (only status/tags mutable)
- Clear ownership (author + agent)
- Temporal awareness (created_at, session_id)
- Visibility controls (shared/machine/private)

---

### ✅ Instructions as Cross-Project Knowledge
Instructions have:
- **Layers**: global (all projects) → project → agent (specific agent)
- **Scope**: Can be scoped to file/path or broad
- **Authority**: Supersedes field for versioning

**Why This Works**:
- Separates universal principles from project-specific rules
- Layering prevents duplicate storage
- Tags enable discovery

---

### ✅ Plans + Claims for Coordination
- **Plans**: Hierarchical (plan → steps), status-tracked, effort-estimated
- **Claims**: Advisory locks on scope, prevents double work
- **Linking**: Claims link to plans, provides visibility

**Why This Works**:
- Explicit ownership prevents chaos
- Steps provide decomposition without creating new items
- Audit trail shows who claimed what and when

---

### ✅ Doctor for Health Checks
- **Consistency**: state.json ↔ project.md sync
- **Security**: Sensitive content detection
- **Governance**: SLA tracking, reviewer capacity
- **Trust**: Circuit breaker for bad actors
- **Scope Hygiene**: Detects misplaced items (new in 0.14!)

**Why This Works**:
- Automated detection catches problems before they compound
- Warnings vs errors allow flexibility
- Checks are composable (can be added incrementally)

---

## Part 2: The Gaps (What's NOT Standardized)

### ❌ Gap 1: No Standard for Project Structure Knowledge
**Current state**: Agents must infer from code
```
Agent: "Where should I put new API endpoints?"
System: (reads constraints)
→ Finds: "TypeScript module: Node16 + ESM"
→ Agent searches codebase, finds src/api/
```

**What's needed**:
```
capabilities.json:
{
  "api": {
    "path": "src/api/",
    "pattern": "[domain]-routes.ts",
    "exports": "Router",
    "examples": ["auth-routes.ts", "user-routes.ts"]
  }
}
```

---

### ❌ Gap 2: No Registry of "How-To" Patterns
**Current state**: Each pattern scattered across code + instructions
- Error handling pattern (src/patterns/error-handling.ts)
- API client pattern (src/clients/base-client.ts)
- Test fixture pattern (tests/fixtures/)

**What's needed**:
```
patterns.json:
{
  "error-handling": {
    "description": "Handle errors in async functions",
    "location": "src/patterns/error-handling.ts",
    "applies_to": ["backend"],
    "example_test": "tests/unit/error-handling.test.ts"
  }
}
```

**MCP Tool**: `bclaw_show_pattern("error-handling")` → loads file + explanation

---

### ❌ Gap 3: No Tool/Skill Dependency Graph
**Current state**: No way to say "Tool A requires Tool B"
```
Problem: Agent installs "deploy" tool but it requires "docker" tool
→ Error at runtime, not at discovery
```

**What's needed**:
```
tools.json:
{
  "deploy-prod": {
    "requires": ["docker", "aws-cli", "helm"],
    "suggests": ["backup-database"],
    "conflicts_with": ["deploy-staging"]
  }
}
```

**MCP Tool**: `bclaw_check_tool_prerequisites("deploy-prod")` → validate setup

---

### ❌ Gap 4: No Capability-to-Tool Mapping
**Current state**: No way to say "I need capability X, which tools provide it?"
```
Agent: "I need to validate JSON schemas"
System: (no registry)
→ Agent manually searches for tool
```

**What's needed**:
```
capabilities.json:
{
  "schema-validation": {
    "provides": ["json-schema", "openapi-validation"],
    "tools": ["tool_ajv-validator", "tool_openapi-validator"]
  }
}

tools.json:
{
  "tool_ajv-validator": {
    "provides_capability": "schema-validation"
  }
}
```

**MCP Tool**: `bclaw_find_tools_for_capability("json-schema")`

---

### ❌ Gap 5: No Workflow/Process Standardization
**Current state**: Complex processes are just instructions + plans
```
Problem: Release process is documented in release.md but not executable
→ Agent reads instructions, manually follows 15 steps
```

**What's needed**:
```
workflows.json:
{
  "release": {
    "description": "Release new version",
    "steps": [
      {"id": "check-branch", "action": "assert_on_master", "required": true},
      {"id": "run-tests", "action": "shell", "cmd": "npm test", "required": true},
      {"id": "bump-version", "action": "brainclaw_version", "args": {...}},
      {"id": "publish", "action": "npm_publish"},
      {"id": "announce", "action": "create_decision", "text": "Released v{VERSION}"}
    ],
    "checkpoints": ["after:run-tests", "before:publish"]
  }
}
```

**MCP Tool**: `bclaw_run_workflow("release", {version: "0.15.0"})`

---

### ❌ Gap 6: No "Project Readiness" Self-Assessment
**Current state**: Doctor checks consistency but not readiness for tasks
```
Problem: Agent starts writing TypeScript but project needs setup
→ No warning until error occurs
```

**What's needed**:
```
requirements.json:
{
  "backend-development": {
    "prerequisites": ["node-v20+", "npm-v10+", "docker"],
    "knowledge": ["async-await", "error-handling", "testing"],
    "conventions": ["conv_naming-files", "conv_error-handling"],
    "assessment": "Can run: npm run test && npm run lint"
  }
}

bclaw_check_readiness("backend-development")
→ Returns:
{
  "ready": true,
  "warnings": ["Node version is v20.5, but recommended is v20.11+"],
  "missing": [],
  "skills": ["async-await: high", "testing: medium"]
}
```

---

### ❌ Gap 7: No Tool Generation Framework
**Current state**: Tools must be manually created
```
Process:
1. Write tool code
2. Register in MCP schema
3. Add handlers
4. Test
5. Document

All manual, error-prone
```

**What's needed**:
```
brainclaw scaffold tool \
  --name "validate-api" \
  --input "openapi_spec: string" \
  --output "validation_report: object" \
  --applies_to "backend"

→ Generates:
- Tool skeleton (TypeScript)
- MCP handler stub
- Test file
- Documentation template
- Auto-registers in tools.json
```

---

## Part 3: Cross-Project Reusability Patterns

### Current: Brainclaw is Single-Project Aware
```
Each .brainclaw/ is isolated to one project
User store (~/.brainclaw/) can be shared across projects
→ But sharing is manual (copy-paste items)
```

### Opportunity: Shared Registries
```
~/.brainclaw/
├── shared-tools.json (common tools across my projects)
├── shared-patterns.json (patterns I use everywhere)
├── shared-conventions.json (my coding style guidelines)
└── shared-capabilities.json (generic capabilities I use)

Project .brainclaw/ inherits + overrides + extends
```

**Example**:
```
~/.brainclaw/shared-conventions.json:
- naming conventions (kebab-case, PascalCase)
- error handling standard
- logging patterns

project/.brainclaw/conventions.json:
- inherits above
- adds: "Use snake_case for database columns"
- overrides: "Use double quotes instead of single"
```

---

## Part 4: Quick Wins (Low Effort, High Value)

### Quick Win 1: Standardize Constraint Categories
**Current**: Constraints have tags but no standard taxonomy
**Fix**: Define standard categories
```
constraint_categories.json:
{
  "categories": ["architecture", "security", "performance", "process", "tooling"],
  "subcategories": {
    "architecture": ["dependencies", "structure", "patterns"],
    "security": ["auth", "data-protection", "secrets"],
    ...
  }
}
```

**Benefit**: Enables `doctor --check architecture` to validate all architecture constraints

### Quick Win 2: Standardize Decision Outcomes
**Current**: Decisions are just text, no tracking if they were successful
**Fix**: Add outcome field
```
Decision {
  ...
  outcome?: {
    status: "working" | "deprecated" | "investigating" | "pending",
    since: "2026-03-18",
    notes: "Implemented in feat/13.0-scope-crud"
  }
}
```

**Benefit**: Agents can find decisions that are still relevant vs abandoned

### Quick Win 3: Standardize Trap Resolution
**Current**: Traps can be marked as "resolved" in constraint status but no trap resolution tracking
**Fix**: Add resolution tracking to traps
```
Trap {
  ...
  resolution?: {
    resolved_in_version: "0.14.0",
    workaround: "Use WSL for git push",
    permanent_fix_ticket: "feat/11.0-ssh-windows"
  }
}
```

**Benefit**: Agents know which traps are still relevant, which are workarounds, which are fixed

---

## Part 5: Schema Additions (Minimal, High-Impact)

### New Memory Item Type: `ProjectCapability`
```typescript
export const CapabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(), // "auth", "api", "storage", "testing", etc
  provided_by: z.string().optional(), // path to implementation
  requires: z.array(z.string()).optional(), // capability IDs this depends on
  tags: z.array(z.string()),
  example_usage: z.string().optional(),
  status: z.enum(['stable', 'experimental', 'deprecated']),
  related_paths: z.array(z.string()).optional(),
});
```

### New Memory Item Type: `ProjectTool`
```typescript
export const ToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(['workflow', 'validator', 'generator', 'utility']),
  implementation: z.string(), // path or command
  mcp_name?: z.string(), // if exposed as MCP tool
  requires: z.array(z.string()).optional(), // tool IDs
  suggests_for: z.array(z.string()).optional(), // agent types
  invocation_example: z.string().optional(),
  tags: z.array(z.string()),
  status: z.enum(['stable', 'experimental', 'deprecated']),
});
```

---

## Summary: Standardization Priority

| Priority | Item | Effort | Value |
|----------|------|--------|-------|
| **P0** | Capability Registry + MCP discovery | Medium | Essential for tool discovery |
| **P0** | Tool Registry + Proposal engine | Medium | Agents can find tools |
| **P1** | Workflow definitions | High | Reduce manual process documentation |
| **P1** | Pattern index | Low | Help agents find code examples |
| **P2** | Tool scaffold generator | High | Accelerate custom tool creation |
| **P2** | Shared registries across projects | Medium | DRY up conventions |
| **P3** | Constraint categories taxonomy | Low | Better doctor checks |
| **P3** | Decision outcome tracking | Low | Find relevant decisions |

---

## Recommended Next Step

**Start with P0**: Implement Capability + Tool registries in v0.15.0
- Clear ROI: Agents can discover what's available
- Foundation for Tier 2 proposal system
- Minimal schema changes
- Enables future work (generators, workflows)
