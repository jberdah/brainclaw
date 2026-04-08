<p align="center">
  <img src="https://brainclaw.dev/logo.png" alt="brainclaw" width="140" />
</p>

<h1 align="center">brainclaw</h1>

<p align="center"><strong>Local-first coordination and shared memory for coding agents.</strong></p>

---

Coding agents (like Copilot, Claude Code, Cursor, or Windsurf) are incredibly powerful, but they work in silos. They forget project constraints, duplicate work, step on each other's files, and lose context between sessions. 

**brainclaw** solves this by providing a unified, local-first memory and coordination layer. It sits alongside your agents, giving them a shared state they can read and write to via MCP (Model Context Protocol) and native agent files.

## Choose Your Playbook

Brainclaw is built to scale with how you use AI. Find the playbook that fits your workflow:

### 🚀 1. Productivity Playbook (End-Users & Solo Devs)
For those who want maximum velocity with minimal overhead.
- **Non-tech creators**: Zero-config setups for Gen-apps. Just ask your agent to 
px brainclaw init and let it handle the rest.
- **Solo Devs**: Never repeat context again. Brainclaw remembers your architecture, known bugs, and decisions across sessions.
- **Power-Users**: Multi-agent orchestration. Use Claude to plan an architecture, and hand off the execution to Cline or Windsurf perfectly using Brainclaw's shared plans.

### 🤝 2. Team & Scale Playbook (Ops & Teams)
For teams scaling AI across their codebase.
- **Team Devs**: Async collaboration. Use claims (claw claim) to prevent two agents from editing the same file concurrently and resolve conflicts safely.
- **Maintainers**: Ship "agent-ready" repositories. Define project constraints and architecture rules in Brainclaw so every new agent automatically respects your repo's standards.
- **CI/CD**: Headless agent integration. Validate PRs automatically against the agreed-upon project constraints.

### 🛠️ 3. Integration Playbook (AI Builders)
For those building the next generation of AI tools.
- **Custom Integration**: Embed Brainclaw's memory and coordination into your proprietary agents via our standard MCP server.
- **Audit & AI Governance**: Keep track of what your autonomous agents are doing. Brainclaw's memory logs decisions, traps, and handoffs, creating a clear audit trail of AI actions.

---

## Works With

Brainclaw doesn't replace your agent; it supercharges it. 

| Logo | Agent | Integration |
|---|---|---|
| [![Claude Code](https://img.shields.io/badge/Claude_Code-111111?logo=anthropic&logoColor=white)](https://github.com/anthropics/claude-code) | **Claude Code** | Full (MCP + Hooks + CLAUDE.md) |
| [![Cursor](https://img.shields.io/badge/Cursor-1F2430?logo=cursor&logoColor=white)](https://cursor.com) | **Cursor** | Standard (MCP + .cursor/rules/) |
| [![Windsurf](https://img.shields.io/badge/Windsurf-0B1220?logo=codeium&logoColor=white)](https://windsurf.com) | **Windsurf** | Standard (MCP + .windsurfrules) |
| [![Cline](https://img.shields.io/badge/Cline-0F766E?logoColor=white)](https://github.com/cline/cline) | **Cline** | Standard (MCP + .clinerules/) |
| [![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-181717?logo=githubcopilot&logoColor=white)](https://github.com/features/copilot) | **GitHub Copilot** | Limited (Skill + copilot-instructions.md) |

*(Supports many more including Codex, Roo, Continue, and Gemini CLI).*

---

## Best Setup: "Agent-First" Onboarding

The best way to install Brainclaw is to *not* install it yourself. Open your favorite coding agent and say:

> "Install Brainclaw in this repo, initialize it, configure the agent integration, and then use Brainclaw for shared context, plans, claims, and handoffs while you work."

If you need the underlying operator commands:
`\ash
npx brainclaw setup --yes
npx brainclaw init
`\

## Platform Support
- **Linux**: Recommended (Best supported)
- **macOS**: Supported
- **Windows / WSL2**: Supported (with minor quoting caveats)

## Documentation
Check out the docs/ folder for deeply tailored guides, or start with:
- docs/quickstart.md for setup.
- docs/integrations/overview.md if you are connecting a new agent.
- docs/cli.md if you are building operator scripts.

## License
Published under the **Business Source License 1.1** (© 2024-2026 Juan Berdah). The core local-first capabilities are intended to transition to an MIT license after the closed beta, keeping core coordination open while hosted features remain commercial.
