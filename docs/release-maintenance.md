# Release Maintenance

Use this guide when a Brainclaw release changes the shipped CLI, MCP surface, context schema, or other operator-facing behavior.

The goal is simple: if the product surface changed, the packaged docs and the anti-drift checks must change in the same branch before publishing.

## When to run this checklist

Run it before:

- `brainclaw version --publish-local`
- a merge that changes operator-visible behavior
- a release candidate or local tarball build used for real agent testing

Run it whenever a change affects one of these surfaces:

- CLI commands, aliases, flags, help text, or examples
- MCP tools, argument semantics, or read/write classification
- context schema version or documented fields
- packaged workflows such as worktrees, notes, plans, claims, bootstrap, or upgrade/reconcile flows

## Release checklist

1. Confirm the runtime surface that changed.
   Check the relevant source files first, typically `src/cli.ts`, `src/commands/mcp.ts`, `src/commands/mcp-read-handlers.ts`, and `src/core/context.ts`.
2. Update the packaged docs in the same branch.
   At minimum touch the matching reference page in `docs/`, and update `README.md` if the change affects the product story or the primary entry path.
3. Reconcile CLI and MCP wording.
   If a concept exists on both surfaces, document the mapping explicitly. Example: `bclaw_write_note` ↔ `brainclaw runtime-note` / `brainclaw note create`.
4. Re-check proposal versus shipped surface.
   If a change is still design-only, keep it out of stable reference pages or mark it clearly as a proposal.
5. Run the doc/reference verification before publishing.

```bash
npm run build:test
node --test dist-test/tests/unit/docs-reference.test.js
```

6. Run targeted command tests for the changed surface.
   Prefer focused tests over broad slow suites when the behavior is small and operator-facing.

Examples from the current repo:

```bash
node --test dist-test/tests/unit/plan-resource-command.test.js
node --test --test-name-pattern "accepts note create as an alias for runtime-note" dist-test/tests/collaboration.test.js
```

7. Only then publish or pack a local release.

```bash
brainclaw version --publish-local --release-notes "..."
```

## Minimum files to review

This is the smallest practical review set for release-visible drift:

- `README.md`
- `docs/index.md`
- `docs/cli.md`
- `docs/integrations/mcp.md`
- `docs/context-format.md`
- `docs/context-format-changelog.md`
- `tests/unit/docs-reference.test.ts`

Add workflow-specific docs when needed, for example:

- `docs/server-operations.md`
- `docs/quickstart.md`
- `docs/concepts/plans-and-claims.md`

## What this checklist is trying to prevent

- shipping a command that exists in code but not in `docs/cli.md`
- claiming a feature is unavailable when the code already ships it
- documenting a proposal as if it were stable product behavior
- leaving MCP and CLI with different names for the same operator workflow
- publishing a local tarball that agents test against while bundled docs still describe the previous surface
