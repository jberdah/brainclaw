# The PROJECT.md Convention (Instruction Layering)

When working with AI agents, balancing **context freshness** against **context bloat** is an ongoing challenge. If you feed an agent too many rules, it consumes tokens and increases the risk of "lazy" behavior or hallucinated context loss.

Brainclaw enforces a strict separation of concerns via "Instruction Layering":

1. **Coordination Rules (The `brainclaw` context):** Managed completely by Brainclaw. This covers memory synchronization, plans, handoffs, and team coordination.
2. **Domain Rules (The Project context):** Managed entirely by you. This covers tech stack features, architecture standards, UI guidelines, and test instructions.

To link these two seamlessly, Brainclaw introduces the canonical **`PROJECT.md` Convention**.

## The Mechanism

Brainclaw treats the `PROJECT.md` file at the root of a workspace as the definitive source of truth for your domain rules. 

When Brainclaw updates the surface instruction files for agents (`CLAUDE.md`, `copilot-instructions.md`, `.cursor/rules`, etc.), it automatically extracts and routes your project vision using a **hybrid injection technique**.

### 1. The "Inject Content" Mode (Short Files, <=20 lines)
If your `PROJECT.md` is concise and serves as a simple "pitch" for the project (under 20 lines), Brainclaw will literally copy its content into the agent surface files under the `## brainclaw — this project` header. 
- **Benefit:** Zero tool calls required by the agent. It gets the pitch instantly on session start.

### 2. The "Inject Pointer" Mode (Detailed Files, >20 lines)
For larger, production-grade projects, your domain rules will easily exceed 20 lines. If Brainclaw injected 300 lines of coding guidelines into every agent prompt file, it would destroy your context window.
Instead, when your `PROJECT.md` exceeds 20 lines, Brainclaw injects a rigid pointer:

> **Project Domain Rules**
> This project maintains detailed domain rules and architecture externally to avoid context bloat.
> You MUST read `PROJECT.md` in the workspace root to understand the project constraints, tech stack, and conventions before coding.

- **Benefit:** Prevents context bloat. The agent uses a targeted file read (`read_file`) only when necessary to acquire deep codebase context.

## Best Practices

- Always keep architecture guidelines, testing boundaries, and specific rules in `PROJECT.md` (or link out to other docs from it).
- Never edit the `<!-- brainclaw:start -->` wrapped contents in surface files manually. They will be overwritten during the next `brainclaw export` cycle.
