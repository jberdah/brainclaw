# Brainclaw Vision: Beyond Memory CRUD

## Current State (v0.14.0)

### ✅ Standardized Elements
- **Memory Items**: Constraints, Decisions, Traps, Instructions, Plans, Claims, Handoffs, Runtime Notes, Candidates
- **Storage**: Multi-level scope (local, repo, workspace, user) with full CRUD
- **Context**: Layered merging from all store levels
- **Coordination**: Trust levels, audit trails, claims, plans
- **Health**: Doctor checks for consistency

### 🔍 What's Missing

#### 1. **Project-Level Metadata & Configuration**
Currently brainclaw stores only `project.md` as output. No standardized way to:
- Define **project capabilities** (what this project CAN do)
- Define **project requirements** (what agents MUST know)
- Define **project conventions** (code style, architecture patterns)
- Define **project scaffolds** (templates for new code)
- Store **project-specific configurations** (build scripts, test runners, deployment targets)

**Problem**: Agents must infer capabilities from constraints/instructions instead of having an explicit registry.

#### 2. **Agent Tooling Registry**
`agent_integrations.declarations` in config.yaml is static and doesn't capture:
- **Which skills/tools are relevant for which agent type** (e.g., frontend agent vs data agent)
- **Which tools are PROJECT-SPECIFIC** vs global
- **Tool dependencies** (tool A requires tool B)
- **Tool context** (when to use this tool, prerequisites)

**Problem**: Agents can't discover project-specific tools they could use.

#### 3. **Workflow/Runbook Definitions**
No standardized way to encode:
- **Recurring processes** (release flow, PR review, deployment)
- **Decision trees** (how to choose between approaches)
- **Checklist workflows** (prerequisites, validation steps)

**Problem**: Common patterns get re-documented in instructions instead of being reusable structures.

#### 4. **Capability Discovery**
No mechanism for agents to ask:
- "What can I do in this project?"
- "What tools are available for my task?"
- "What patterns should I follow for [domain]?"

#### 5. **Tool/Skill Generation**
No standardized way to:
- **Propose** project-specific tools based on context
- **Generate** boilerplate for new tools
- **Register** custom MCP servers at project level
- **Integrate** generated tools into agent context

---

## Proposed Architecture

### Tier 1: Standardize Project Metadata (v0.15.0)

#### 1a. **Project Capabilities Registry**
```yaml
# .brainclaw/capabilities.json
{
  "capabilities": [
    {
      "id": "api-client",
      "name": "REST API Client",
      "description": "HTTP client for calling external APIs",
      "tags": ["http", "networking", "external"],
      "required_for": ["frontend", "integration-tests"],
      "provided_by": "axios + custom wrapper in src/http/client.ts"
    },
    {
      "id": "auth-service",
      "name": "Authentication Service",
      "description": "JWT-based auth for users",
      "tags": ["security", "auth"],
      "requires": ["api-client"],
      "entry_point": "src/auth/service.ts",
      "exported": ["AuthService", "verifyToken", "refreshToken"]
    }
  ],
  "domains": [
    {
      "name": "backend",
      "description": "Node.js/TypeScript backend",
      "capabilities": ["api-client", "auth-service", "database"],
      "tech_stack": ["Node.js 20+", "TypeScript", "Express"]
    }
  ]
}
```

**CLI**: `brainclaw capability list`, `brainclaw capability add`, `brainclaw capability describe <id>`
**MCP**: `bclaw_get_capabilities`, `bclaw_list_capabilities`

#### 1b. **Project Conventions Registry**
```yaml
# .brainclaw/conventions.json
{
  "conventions": [
    {
      "id": "conv_naming-files",
      "category": "naming",
      "applies_to": ["typescript", "files"],
      "rule": "Use kebab-case for file names, PascalCase for class exports",
      "example": "src/auth-service.ts exports AuthService class",
      "exceptions": ["index.ts", "*.d.ts"],
      "severity": "high"
    },
    {
      "id": "conv_error-handling",
      "category": "patterns",
      "applies_to": ["backend"],
      "rule": "All async functions must handle errors with try-catch or .catch()",
      "pattern": "See src/patterns/error-handling.ts",
      "severity": "high"
    }
  ]
}
```

**CLI**: `brainclaw convention list`, `brainclaw convention check <pattern>`
**MCP**: `bclaw_get_conventions`, `bclaw_search_convention`

#### 1c. **Project Requirements Registry**
```yaml
# .brainclaw/requirements.json
{
  "requirements": [
    {
      "id": "req_backend-knowledge",
      "category": "knowledge",
      "applies_to": ["backend"],
      "requirement": "Must understand async/await patterns and Promise chains",
      "assessment": "backend-async-test.js",
      "link_to_docs": "docs/backend/async-guide.md"
    },
    {
      "id": "req_testing-coverage",
      "category": "process",
      "applies_to": ["all"],
      "requirement": "All new code must have test coverage >= 80%",
      "enforced_by": "npm run test:coverage:check",
      "link_to_docs": "docs/testing.md"
    }
  ]
}
```

---

### Tier 2: Tool Discovery & Proposal System (v0.16.0)

#### 2a. **Project-Specific Tools Registry**
```yaml
# .brainclaw/tools.json
{
  "tools": [
    {
      "id": "tool_validate-pr",
      "type": "workflow",
      "name": "PR Validation Tool",
      "description": "Validates PR against project standards",
      "triggers": ["before-merge", "code-review"],
      "implementation": ".brainclaw/tools/validate-pr.js",
      "requires": ["test-runner", "linter"],
      "suggests_for": ["reviewer", "contributor"],
      "mcp_name": "brainclaw-validate-pr"
    },
    {
      "id": "tool_generate-api-client",
      "type": "generator",
      "name": "API Client Generator",
      "description": "Generates typed API clients from OpenAPI spec",
      "implementation": "scripts/generate-client.ts",
      "input_schema": {"spec_path": "string"},
      "output": "src/clients/generated/",
      "suggests_for": ["backend", "frontend"]
    }
  ]
}
```

**MCP Tools**:
- `bclaw_list_tools` - find tools relevant for current task
- `bclaw_get_tool_info <id>` - get details + usage
- `bclaw_suggest_tools` - AI-powered suggestions based on context
- `bclaw_invoke_tool` - run tool with arguments

#### 2b. **Tool Proposal Engine**
When an agent:
1. **Starts a session**: "Are there relevant tools for [task]?"
2. **Asks `bclaw_get_context`**: Includes `suggested_tools` in response
3. **Encounters specific patterns**: "I detect you're building API client → would you like `tool_generate-api-client`?"

**Suggestion Rules**:
- Match task tags → tool tags
- Match domain → tool applies_to
- Match previous usage patterns
- LLM-based: "Given this problem, recommend 3 tools"

---

### Tier 3: Custom Tool/MCP Generation (v0.17.0)

#### 3a. **MCP Server Scaffold Generator**
```bash
brainclaw scaffold mcp \
  --name "project-linter" \
  --description "Lints code against project conventions" \
  --tools "lint-file,check-naming,validate-patterns"
```

Generates:
```
.brainclaw/mcp/project-linter/
├── SKILL.md (MCP server definition)
├── tool-schemas.json (MCP tool contracts)
├── handlers/
│   ├── lint-file.ts
│   ├── check-naming.ts
│   └── validate-patterns.ts
├── tests/
└── package.json (dependencies)
```

#### 3b. **Skill/Tool Scaffold Generator**
```bash
brainclaw scaffold skill \
  --name "enforce-conventions" \
  --type "validation" \
  --applies_to "typescript,backend"
```

Generates:
```
.brainclaw/skills/enforce-conventions/
├── SKILL.md (metadata)
├── implementation.ts
├── test-cases.json
└── examples.md
```

#### 3c. **Generator Integration**
```bash
brainclaw generate api-client \
  --spec ./api.openapi.json \
  --output src/clients/generated
```

This would:
1. Register tool in tools.json
2. Generate code
3. Add CLI command or MCP handler
4. Propose to agents via `bclaw_suggest_tools`

---

### Tier 4: Unified Discovery Context (v0.18.0)

When an agent calls `brainclaw context`:

```json
{
  "project_metadata": {
    "capabilities": [...],
    "domains": [...],
    "conventions": [...],
    "requirements": [...]
  },
  "available_tools": [
    {
      "tool_id": "tool_validate-pr",
      "relevance_score": 0.95,
      "why": "PR validation matches your merge task"
    }
  ],
  "suggested_next_steps": [
    "Use bclaw_invoke_tool pr-validator before merging",
    "Check conventions for commit message format",
    "Ensure test coverage >= 80%"
  ]
}
```

---

## Implementation Roadmap

| Version | Feature | Effort | Impact |
|---------|---------|--------|--------|
| **0.15** | Capabilities + Conventions registries + CLI | Medium | 🔧 Enables tool discovery |
| **0.16** | Tool registry + Proposal engine + MCP tools | Medium | 🎯 Agent guidance |
| **0.17** | Scaffold generators (MCP/skill/tools) | High | 🚀 Accelerates custom tools |
| **0.18** | Unified discovery context | Low | 📊 Complete visibility |

---

## Key Design Principles

1. **Agnostic to filesystem**: All in JSON/YAML, store-level aware
2. **Composable**: Tools suggest other tools, workflows suggest tools
3. **Discoverable**: Every element has tags + metadata for search
4. **Generative**: Tools can create other tools
5. **Contextual**: Suggestions adapt to agent, domain, task
6. **Audit-able**: Tool invocation logged like claims/decisions

---

## Example: Agent Workflow

### Before (v0.14)
```
Agent: "How do I validate this PR?"
System: (reads constraints/instructions)
→ Finds: "All new code must have test coverage >= 80%"
→ Agent manually searches for test runner
```

### After (v0.18)
```
Agent: calls bclaw_get_context(task: "review PR before merge")
System returns:
{
  "suggested_tools": [
    "tool_validate-pr" (relevance: 0.95),
    "tool_test-coverage" (relevance: 0.87)
  ],
  "conventions_to_check": [
    "conv_naming-files",
    "conv_error-handling"
  ],
  "requirements": ["test coverage >= 80%"]
}
Agent: bclaw_invoke_tool("tool_validate-pr", {pr_number: 123})
→ Tool runs checks, returns validation report
→ Agent creates decision: "PR validated against 12 project standards"
```

---

## Questions for Feedback

1. **Priority**: Should we tackle Tier 1 (metadata) first before Tier 2 (discovery)?
2. **Scope**: Include "workflow definitions" (Tier 2.5) or keep it separate?
3. **Tool ownership**: Should tools be managed by a curator/admin or be crowdsourced?
4. **Integration**: Should `brainclaw setup` auto-generate basic capabilities/conventions registries?
5. **AI enhancement**: Should we use LLM to auto-index existing code for capabilities?
