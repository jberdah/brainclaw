# Code Map

Code Map is a per-project structural index of your JavaScript / TypeScript / JSX /
TSX, Python, PHP, and Java codebase. It parses each supported file with Tree-sitter and records the
symbols it defines (functions, classes, types, interfaces, React components and
hooks), what it imports and exports, and how files relate — then answers fast
"what should I read before I edit this?" questions for both human operators and
coding agents.

Code Map is a **discovery aid**, not a build artifact. It never changes your
code, never blocks `bclaw_work`, and degrades gracefully: if the index is
missing or stale, every command says so via a freshness badge instead of
returning silently wrong answers.

The index lives under `.brainclaw/code-map/` (one JSONL shard per file, plus
named symbol/import indexes and a manifest). It is safe to delete; a refresh
rebuilds it.

## When to use it

- **Before editing** an unfamiliar area: `code-map brief <symbol-or-path>` (or
  `bclaw_code_brief`) returns a ranked list of files to read plus related
  brainclaw memory.
- **To locate** a function/class/component/hook by name without grepping:
  `code-map find <query>` (or `bclaw_code_find`).
- **To check coverage / staleness**: `code-map status` (or `bclaw_code_status`).
- **After pulling changes or doing work**: `code-map refresh` to bring the index
  back to `fresh`.

## CLI

All commands are available as `brainclaw code-map …` or `bclaw code-map …`, and
honor the global options (`--cwd`, `--verbose`, `--debug`). Every command also
accepts `--json` for machine-readable output, and prints a `Freshness:` line.

### `brainclaw code-map status`

Read-only. Reports whether the store exists, the freshness badge, and index
stats (files indexed, nodes, edges). Never refreshes.

```bash
brainclaw code-map status
```

```
Code Map status
  Store:    present
  Freshness: fresh
  Files:    142
  Nodes:    1873
  Edges:    2410
```

### `brainclaw code-map refresh [--changed | --all]`

Rebuilds the index behind a per-project lock. Defaults to `--changed`.

| Flag | Behavior |
|---|---|
| `--changed` (default) | Re-parses files whose **content** changed (git status + file-hash diff) **and** any shard whose stored extractor-config / grammar / engine hashes no longer match the current ones (i.e. `stale_extractor` / `stale_grammar`). A config or grammar bump is therefore healed by this cheap path — not only by `--all`. Compaction is limited to git-proven deletes. |
| `--all` | Enumerates every supported file, re-parses, and performs full orphan compaction (drops shards whose file is gone or now ignored). |

If a live writer already holds the project lock, `refresh` **fails fast** with a
clear status rather than blocking — it never stalls `bclaw_work`.

```bash
brainclaw code-map refresh            # changed (cheap, default)
brainclaw code-map refresh --all      # full rebuild + compaction
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

## MCP tools

Capable agents should prefer the MCP surface. The four tools mirror the CLI and
all return a `freshness_badge`:

| Tool | Kind | Purpose |
|---|---|---|
| `bclaw_code_status` | read | Store presence, freshness badge, index stats. Never refreshes. |
| `bclaw_code_find` | read | Ranked symbol-index search (`query`, optional `limit`). Never refreshes. |
| `bclaw_code_brief` | read | Reading brief for a symbol/path (`target`, optional `limit`, files capped at 12). Never refreshes. |
| `bclaw_code_refresh` | write | Rebuild the index. `scope` = `"changed"` (default) or `"all"`. Fails fast on a live lock. |

The read tools never trigger a parse — if `bclaw_code_status` /
`bclaw_code_find` / `bclaw_code_brief` report `missing_index` or a stale badge,
call `bclaw_code_refresh` and retry.

## Freshness badge model

Every Code Map response carries a freshness badge so a stale index is always
visible rather than silently misleading. The status is one of:

| Status | Meaning | Fix |
|---|---|---|
| `fresh` | Index matches the working tree, the extractor config, and the parser binaries. | — |
| `stale_changed_files` | One or more indexed files have changed on disk since they were parsed. | `refresh --changed` |
| `stale_extractor` | The extractor configuration (ignore rules, size caps, supported extensions, query budget, or active language set) changed since these shards were produced. | `refresh --changed` (heals on the cheap path) |
| `stale_grammar` | A Tree-sitter grammar (or the engine glue) binary changed since these shards were produced. | `refresh --changed` (heals on the cheap path) |
| `partial` | The index could not be fully read/built this pass (e.g. the project lock was held by a live writer). | retry |
| `missing_index` | No index exists yet for this project. | `refresh --all` |

Staleness reasons are kept separate on purpose: a content change
(`stale_changed_files`) is independent from a config change (`stale_extractor`)
which is independent from a parser-binary change (`stale_grammar`). The badge
surfaces the dominant reason; `--json` output and the manifest carry the per-file
counts.

**Index freshness vs this call's spot-check.** `bclaw_code_status` reports the
*index* freshness (the manifest state). `bclaw_code_find` / `bclaw_code_brief`
additionally run a bounded, per-query *spot-check* of the files they actually
touch — so a single call can read `stale_changed_files` (a file it looked at
changed on disk) or `partial` (the spot-check hit its budget) even while the index
itself is `fresh`. When the call-level status diverges from the index, the badge
carries an `index_status` detail so the two are not confused, e.g.
`{ status: "partial", details: { index_status: "fresh", partial_reason:
"lazy_check_budget_exhausted" } }` reads as *"index fresh, this call's spot-check
incomplete (budget)"* — not a contradiction with a `fresh` `status()`.

## Lifecycle — pull-based, no daemon

Code Map never runs in the background and never auto-reindexes. The model is lazy
reconciliation at the read path:

1. You edit or pull code — the index does not change.
2. The next `status` / `find` / `brief` recomputes a freshness badge (git status +
   file-hash diff vs the stored shards), so a stale index is always *visible*,
   never silently wrong.
3. `refresh --changed` re-parses only the changed files (incremental); `--all` does
   a full rebuild + orphan compaction.
4. `bclaw_work` nudges a refresh when the badge is `missing_index` or stale, so an
   agent knows to reconcile before trusting the map.

It never blocks `bclaw_work` (a held lock fails fast), so the worst case of a stale
index is a one-line "run refresh" hint — not a wrong answer.

## Monorepos and nested projects

Code Map is **per project**: the index lives at `<project>/.brainclaw/code/`, and
`refresh` indexes the source tree under the project root it runs in — descending
into subdirectories but skipping `node_modules`, `dist`, `.git`, `.brainclaw`,
`vendor`, `target`, … at any depth.

There is no nested-project *boundary*, so the scope follows **where you run it**:

| You run refresh / find / brief … | … against |
|---|---|
| at the monorepo root | one index covering the whole tree (every child project's source) |
| inside a child project (e.g. `apps/api`) | that child's own index, at `apps/api/.brainclaw/code/` |

When an agent works inside a child project, brainclaw's project resolution routes
Code Map to **that child** — the same per-project scoping that powers `bclaw_work`
/ `bclaw_switch` — so each project gets its own clean map without manual `--cwd`
juggling. A submodule that is itself an application (under e.g. `apps/`) is indexed
like any other directory.

**Not yet supported** (roadmap):

- A single aggregated view that keeps **separate per-child indexes and federates
  them** at the root (a query spanning services without double-indexing).
- **Cross-service edges** — e.g. linking an API call to the route that defines it in
  another service. Code Map indexes language *symbols* and *module imports*, not
  framework routes or runtime HTTP calls, so it does not (today) map "service A calls
  endpoint X defined in service B".

## WASM bundling note

The parser is [Tree-sitter](https://tree-sitter.github.io/) compiled to
WebAssembly. The engine glue (`web-tree-sitter`) and the prebuilt grammar `.wasm`
files (JavaScript / TypeScript / JSX / TSX, Python, PHP, Java) are **bundled into the package** during the
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
