# Security Policy

## Reporting a vulnerability

Please report security issues privately — do **not** open a public issue for an
unpatched vulnerability.

- Preferred: GitHub **[Private vulnerability reporting](https://github.com/jberdah/brainclaw/security/advisories/new)**.
- Or email **support@brainclaw.dev** with steps to reproduce and impact.

We aim to acknowledge within a few business days and to coordinate a fix and
disclosure timeline with you.

## Supported versions

brainclaw is pre-1.x-stable in spirit: security fixes land on the latest
published `1.x` release. Older versions are not back-patched — upgrade to the
latest `brainclaw` on npm.

## What brainclaw is (and is not) responsible for

brainclaw is a **shared-state and coordination layer** for humans and AI coding
agents: it stores plans, claims, handoffs, decisions, and traps under
`.brainclaw/`, builds prompt-sized context, and can **dispatch** agent CLIs to
run work in isolated git worktrees.

It is **not** a code-execution sandbox and does not inspect, vet, or guarantee
the safety of code that agents generate or run. Treat AI agents as **untrusted
contributors**: brainclaw's job is to make their actions observable, scoped, and
reviewable — not to make arbitrary generated code safe.

### Real security surface (and current mitigations)

- **Stored memory may capture secrets.** Free text (notes, handoffs, candidates)
  can quote anything. brainclaw applies **redaction** on write and blocks
  **sensitive paths** (`.env`, `secrets/`, `.git/`, `node_modules/`) by default.
  See [`docs/security.md`](docs/security.md). Detection is best-effort — never
  rely on it as your only control, and never paste production credentials into
  agent context.
- **Dispatch spawns agent CLIs with broad permissions.** To run work headlessly,
  brainclaw invokes agents such as `codex exec --sandbox workspace-write` or
  `copilot -p ... --allow-all`. Those flags grant the agent file/command access
  within its worktree. Only dispatch to agents and on machines you trust, and
  review the resulting diffs before merging.
- **Local-first by default.** No telemetry and no mandatory cloud; `.brainclaw/`
  is plain text + JSON you can inspect and version in git. Cross-machine
  federation is opt-in and gated behind explicit configuration.

## Hardening recommendations for operators

- Run agents in **isolated workspaces / worktrees** (brainclaw's dispatch does
  this by default) and keep production credentials out of the agent environment.
- **Review diffs** produced by agents before merging; treat auto-execution as
  opt-in.
- Keep `.brainclaw/` out of any context you share publicly if your notes could
  contain sensitive project detail.

See [`docs/security.md`](docs/security.md) for the redaction patterns, sensitive
path list, and configuration details.
