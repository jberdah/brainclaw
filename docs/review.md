# Review and Reflection

brainclaw includes a reflective layer so not every observation has to become canonical memory immediately.

## Why this exists

Some facts are:

- durable and worth keeping
- useful but still uncertain
- too local or too temporary to promote immediately

A review layer helps filter and promote the right items.

## Typical flow

```
runtime-note → reflect-runtime-note → review candidate → accept / reject
```

1. capture a runtime note (`brainclaw runtime-note`)
2. reflect it into a candidate when useful (`brainclaw reflect-runtime-note`)
3. review the candidate (`brainclaw review`)
4. accept or reject it (`brainclaw accept` / `brainclaw reject`)

## Star and use signals

Before formal review, candidates can accumulate signals:

```bash
brainclaw star-candidate cnd_001 --by copilot    # passive interest
brainclaw use-candidate cnd_001 --by copilot --context "auth rollout"  # active reuse
```

`review --prioritized` uses these signals (along with freshness and semantic relevance) to surface the most important candidates.

## curator role

The `curator` trust level has direct promote access. Other roles create candidates for review.

## Why this is valuable

This keeps canonical memory cleaner while still preserving useful observations long enough to evaluate them.
