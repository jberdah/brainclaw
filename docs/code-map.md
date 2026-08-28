# Code Map

Code Map is a per-project structural index of your codebase across 11 languages:
JavaScript / TypeScript (including JSX / TSX), Python, PHP, Java, Go, Rust, C#,
Ruby, C, and C++. It parses each supported file with Tree-sitter and records the
symbols it defines (functions, classes, types, interfaces, React components and
hooks), what it imports and exports, and how files relate — then answers fast
"what should I read before I edit this?" questions for both human operators and
coding agents.

Code Map is a **discovery aid**, not a build artifact. It never changes your
code, never blocks `bclaw_work`, and degrades gracefully: if the index is
missing or stale, every command says so via a freshness badge instead of
returning silently wrong answers.

The index lives under `.brainclaw/code/` (one JSONL shard per file, plus
named symbol/import indexes and a manifest). It is safe to delete; a refresh
rebuilds it.

## When to use it

- **Before editing** an unfamiliar area: `code-map brief <symbol-or-path>` (or
  `bclaw_code_brief`) returns a ranked list of files to read plus related
  brainclaw memory.
- **To locate** a function/class/component/hook by name without grepping:
  `code-map find <query>` (or `bclaw_code_find`).
- **To inspect a bounded local dependency neighborhood**: `code-map export <symbol-or-path>` (or `bclaw_code_export`) returns compact nodes and edges, not a repository graph dump.
- **To check coverage / staleness**: `code-map status` (or `bclaw_code_status`).
- **After pulling changes or doing work**: `code-map refresh` to bring the index
  back to `fresh`.

## CLI

All commands are available as `brainclaw code-map …` or `bclaw code-map …`, and
honor the global options (`--cwd`, `--verbose`, `--debug`). Every command also
accepts `--json` for machine-readable output, and prints a `Freshness:` line.

### `brainclaw code-map status`

Read-only. Reports whether the physical store path exists, whether a valid
index is readable, the freshness badge, and index stats (files indexed, nodes,
edges). `store_exists`, `index_exists`, and `index_manifest_exists` deliberately
separate a directory containing job records from a usable index. Never refreshes.

```bash
brainclaw code-map status
```

```
Code Map status
  Store:    present
  Index:    ready
  Root:     /workspace/apps/api
  Path:     /workspace/apps/api/.brainclaw/code
  Freshness: fresh
  Files:    142
  Nodes:    1873
  Edges:    2410
```

### `brainclaw code-map refresh [--changed | --all | --scope changed|all]`

Rebuilds the index behind a per-project lock. Defaults to `--changed`.

| Flag | Behavior |
|---|---|
| `--changed` (default) | Re-parses files whose **content** changed (git status + file-hash diff) **and** any shard whose stored extractor-config / grammar / engine hashes no longer match the current ones (i.e. `stale_extractor` / `stale_grammar`). A config or grammar bump is therefore healed by this cheap path — not only by `--all`. Compaction is limited to git-proven deletes. |
| `--all` | Enumerates every supported file, re-parses, and performs full orphan compaction (drops shards whose file is gone or now ignored). |
| `--scope changed\|all` | Uses the same scope spelling as MCP. Existing `--changed` / `--all` flags remain supported. |

If a live writer already holds the project lock, `refresh` **fails fast** with a
clear status rather than blocking — it never stalls `bclaw_work`.

```bash
brainclaw code-map refresh            # changed (cheap, default)
brainclaw code-map refresh --all      # full rebuild + compaction
brainclaw code-map refresh --scope changed
```

### `brainclaw code-map find <query>`

Read-only. Searches the symbol index for a name/token and returns ranked matches
with path and score. A `missing_index` badge means you should run `refresh`
first.

```bash
brainclaw code-map find useAuth
```

```
Code Map find: "useAuth"
  Freshness: fresh
  [9.0] useAuth hook — src/hooks/useAuth.ts
```

### `brainclaw code-map brief <symbol-or-path>`

Read-only. Builds a reading brief for a symbol or file: a ranked
`suggested files to read` list (capped at 12) plus related brainclaw memory
(decisions / constraints / traps, capped at 5). Use it before editing.

```bash
brainclaw code-map brief App
```

### `brainclaw code-map export <symbol-or-path>`

Read-only export of a **local** persisted subgraph around one symbol or file. It
never refreshes, reparses, calls a service, or silently turns into a whole-project
graph export. The default is one hop in both directions; limits are always
reported and hard-capped at depth 4, 100 nodes, and 200 edges.

```bash
brainclaw code-map export useAuth --direction incoming --depth 2 --json
brainclaw code-map export src/hooks/useAuth.ts --format mermaid
```

`--direction` is `outgoing`, `incoming`, or `both` (default). `--max-nodes` and
`--max-edges` can tighten the response only; `--min-confidence` cannot be set
below 0.5. JSON is canonical and includes compact `nodes`, `edges`, root IDs,
limits, truncation flags, and a freshness badge. Every edge retains `kind`,
`source`, and `confidence`; low-confidence nodes/relations are excluded so an
extraction heuristic cannot appear indistinguishable from a high-confidence
relation. `--format mermaid` adds a Mermaid rendering projected from those exact
JSON nodes and edges—never from a second traversal.

## MCP tools

Capable agents should prefer the MCP surface. The read tools mirror the CLI and
all return a `freshness_badge`:

| Tool | Kind | Purpose |
|---|---|---|
| `bclaw_code_status` | read | Active-session or explicit `project` store/path/index diagnostics, freshness, stats, and latest refresh job; `cascade=true` also follows the latest cascade job. Never refreshes. |
| `bclaw_code_find` | read | Ranked symbol-index search (`query`, optional `limit`/`project`). Never refreshes. |
| `bclaw_code_brief` | read | Reading brief for a symbol/path (`target`, optional `limit`/`project`, files capped at 12). Never refreshes. |
| `bclaw_code_export` | read | Bounded local subgraph around required `target`; direction/depth/node/edge caps, confidence filtering, and optional Mermaid projection. Never refreshes. |
| `bclaw_code_refresh` | write | Accept a durable background rebuild and return immediately. `scope` = `"changed"` (default) or `"all"`; optional `project` targets a named/id/path project, and `cascade=true` spans a workspace. |

Every MCP Code Map tool accepts the same optional `project` selector (project
name, id, or workspace-relative path). It overrides the active session for that
call without mutating the session.

The read tools never trigger a parse — if `bclaw_code_status` /
`bclaw_code_find` / `bclaw_code_brief` report `missing_index` or a stale badge,
call `bclaw_code_refresh` and retry.

## Freshness badge model

Every Code Map response has one top-level `freshness` field:
`fresh`, `stale`, `partial`, or `missing`. It is the synthetic index signal that
an agent uses to decide whether to refresh, and it has the same meaning on
`bclaw_work`, `bclaw_code_status`, `bclaw_code_find`, and `bclaw_code_brief`.

```json
{
  "freshness": "fresh",
  "details": {
    "index": {
      "status": "fresh",
      "stale_file_count": 0,
      "partial_reason": null,
      "git_head_changed": null
    },
    "spot_check": {
      "status": "stale",
      "checked_files": 1,
      "stale_changed_files": ["src/example.ts"],
      "deleted_files": [],
      "unchecked_files": [],
      "budget_exhausted": false,
      "partial_reason": null
    }
  }
}
```

`details.index` is the index diagnosis: its detailed `status` may be
`stale_changed_files`, `stale_extractor`, `stale_grammar`, or
`stale_git_head`. `details.spot_check` is a bounded, read-only observation of
the candidates touched by `find` or `brief`; it is `not_run` on `status` and on
a work section with no query. A stale or partial spot-check never silently
changes the shared top-level signal. It gives the agent precise evidence for an
explicit `bclaw_code_refresh(scope="changed")`, then a retry.

No read command parses files or refreshes the index. `bclaw_work` can suggest
that explicit refresh, but never performs it lazily.
## Lifecycle — pull-based, no daemon

Code Map never auto-reindexes and has no daemon. The model is lazy
reconciliation at the read path:

1. You edit or pull code — the index does not change.
2. The next `status` / `find` / `brief` recomputes a freshness badge (git status +
   file-hash diff vs the stored shards), so a stale index is always *visible*,
   never silently wrong.
3. `refresh --changed` re-parses only the changed files (incremental); `--all` does
   a full rebuild + orphan compaction. MCP refreshes are explicit durable jobs;
   their progress is read through `bclaw_code_status` (or
   `bclaw_code_status(cascade=true)` for a workspace cascade).
4. `bclaw_work` nudges a refresh when the badge is `missing_index` or stale, so an
   agent knows to reconcile before trusting the map.

It never blocks `bclaw_work` (a held lock fails fast), so the worst case of a stale
index is a one-line "run refresh" hint — not a wrong answer.

## Monorepos and nested projects

Code Map is **per project**: the index lives at `<project>/.brainclaw/code/`, and
`refresh` indexes the source tree under the project root it runs in — descending
into subdirectories but skipping `node_modules`, `dist`, `.git`, `.brainclaw`,
`vendor`, `target`, … at any depth.

By default there is no nested-project *boundary*, so a plain (non-cascade) scope
follows **where you run it**:

| You run refresh / find / brief … | … against |
|---|---|
| at the monorepo root (plain) | one index covering the whole tree (every child project's source) |
| inside a child project (e.g. `apps/api`) | that child's own index, at `apps/api/.brainclaw/code/` |

When an agent works inside a child project, brainclaw's project resolution routes
Code Map to **that child** — the same per-project scoping that powers `bclaw_work`
/ `bclaw_switch` — so each project gets its own clean map without manual `--cwd`
juggling. A submodule that is itself an application (under e.g. `apps/`) is indexed
like any other directory.

Both CLI and MCP status responses disclose the exact resolved project root and
Code Map store path. The MCP response additionally includes `active_source`, the
resolved project identity, the running server version, and the package version
visible on disk. `store_exists` describes the physical directory;
`index_exists` describes a valid readable manifest. In a monorepo, compare
these fields before concluding that an index is missing: a root store and a
child store are intentionally distinct. If the versions differ, restart the
MCP server; if the roots differ, use `project="<name-or-path>"`, select the
intended session project, or pass `cascade=true` at the workspace root.

### Cascading a multi-project workspace (`--cascade`)

In a `project_mode: multi-project` workspace, one refresh at the root can index
the whole monorepo **per project** instead of building one monolithic root index:

```bash
brainclaw code-map refresh --all --cascade     # CLI
# bclaw_code_refresh(scope="all", cascade=true) # MCP
```

This refreshes **every nested brainclaw project** into its own
`<child>/.brainclaw/code/` store, and refreshes the **root** store *scoped to the
files no child owns*. The rule is "each file is indexed by exactly the most
specific brainclaw project that contains it" — so there is **zero
double-indexing**, even when projects nest inside one another. `--cascade` is
opt-in; without it, the root refresh keeps its single-tree behaviour (above), and
single-project repos ignore the flag entirely.

The CLI cascade stays synchronous. Every MCP refresh returns a durable `job_id`
immediately, avoiding client timeouts; follow a normal refresh with
`bclaw_code_status(project=...)`, or a cascade with
`bclaw_code_status(cascade=true)`. Status reports completed
and total project counts, the project currently being indexed, and terminal
outcomes. Successful rows are aggregated; only exceptions are named. A project
with a valid empty index is labeled `no_eligible_files`, while lock contention and
refresh failures remain distinct (`locked` / `failed`). `discovery_truncated=true`
warns that the bounded nested-project scan could not inspect deeper branches, so
the reported project total must not be treated as complete.

### Workspace-wide `find` / `brief`

Once the per-child indexes exist (built by `--cascade`), `find` and `brief` run
at a multi-project workspace **root** automatically aggregate across every child
project's store — no flag needed. Matches are project-tagged with
workspace-relative paths, and the freshness badge merges per-store status (worst
status wins) plus coverage. Missing child stores make the top-line badge
`partial`, never `fresh`; diagnostics carry status counts and only the non-fresh
exceptions instead of repeating every project. Weak shared-token candidates that
do not contain the normalized query are omitted rather than returned as plausible
score-1/2 noise. An aggregated `brief` also surfaces **cross-package reverse
dependents**: sibling packages that import the defining package's public name
rank into the reading list, flagged `cross_package`.

From **inside** a child project, reads stay single-store by default (locality).
An explicit `traversal: "workspace"` (backend option) walks up to the nearest
enclosing multi-project root and aggregates from there, with the caller's own
package ranked first (`local: true` on its rows).

**Not yet supported** (roadmap):

- **Cross-service edges** — e.g. linking an API call to the route that defines it in
  another service. Code Map indexes language *symbols* and *module imports*, not
  framework routes or runtime HTTP calls, so it does not (today) map "service A calls
  endpoint X defined in service B".

## WASM bundling note

The parser is [Tree-sitter](https://tree-sitter.github.io/) compiled to
WebAssembly. The engine glue (`web-tree-sitter`) and the prebuilt grammar `.wasm`
files — 12 grammars covering the 11 supported languages: `javascript` (also
handles JSX), `typescript`, `tsx`, `python`, `php`, `java`, `go`, `rust`,
`c_sharp`, `ruby`, `c`, `cpp` — are **bundled into the package** during the
build (`scripts/copy-code-map-wasm.mjs` copies them into `dist/wasm/` and vendors
the engine glue into `dist/vendor/web-tree-sitter/`).

Two properties matter for packaging:

1. **Lazy load on first parse only.** The WASM engine is loaded via a dynamic
   import the first time a file is actually parsed. Nothing in the CLI / MCP
   module-load graph statically imports the parser, so `--version`,
   `code-map status`, `code-map find`, and `code-map brief` all work even if the
   engine is absent — only `refresh` needs it.
2. **Self-contained at runtime.** Because the glue and grammars are vendored into
   `dist/`, parsing works from the published package without the build-time
   dev dependencies. WASM assets are resolved relative to the module
   (`import.meta.url`), never the current working directory, so the loader is
   safe inside git worktrees.
