# Reputation

Reputation in brainclaw is a bounded trust signal, not a gamified score system.

## Purpose

Its role is to support:

- review routing
- context ranking tie-breakers
- continuity summaries

It is **not** a leaderboard or a mutable points ledger.

## How it works

Three subscores are tracked:

| Subscore | What it measures |
|---|---|
| `contribution_quality` | Quality and adoption of contributed items |
| `review_reliability` | Consistency of review participation |
| `continuity_hygiene` | Session and claim hygiene behaviour |

These feed an internal bounded score named `internal_trust` computed from a rolling window of recent observable behavior.

## Configuration

```yaml
reputation:
  enabled: true
  visibility: summary       # 'summary' or 'internal-only'
  decay_days: 30
  ranking_weight: 0.15
  resume_weight: 0.35
  mcp_exposure: true
```

## Where reputation surfaces

- `status --json` — internal snapshot (when enabled)
- `context` — compact `resume_summary` + small ranking bonus
- `list-agents --with-reputation` — bounded public summaries
- `agent-board --with-reputation` — aggregate + selected agent summary
- `doctor --json` — high-level metrics only
- MCP board consumers — opt-in with `includeReputation`

## Product caution

This feature is advanced and should stay secondary to the core product story.
The primary value of brainclaw is shared workspace coordination, not reputation mechanics.
Quality matters more than volume. Semantic relevance still dominates ranking.
