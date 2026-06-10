# Federated Identity Model — PROPOSAL

> Status: **PROPOSAL** for the architecture loop (Codex schema review + Juan
> product calls). Not a decision. Produced 2026-06-11 from a two-track
> identity analysis (local model + federation readiness); full reports held
> by the coordinator. Couples directly with `event-log-store.md` OPEN
> QUESTION **C4** (federation conflict primitive) — review them together.

## Why

The federation ambition: several human users, each running one or more
agents, working on the same project from different machines. Today's
identity tuple `{agent_name, agent_id, host_id, user}` is locally minted,
unauthenticated, and name-keyed at every load-bearing point:

- Cloud inbox routed by **bare agent name** (`/api/v1/inbox/claude-code`)
  — two humans' claude-codes are one identity to the bus.
- Event cursors, claim ownership comparisons, reputation, trust: keyed by
  name or per-store registry doc; "Juan's claude-code" is **inexpressible**.
- `FederationMessage.from` is self-asserted under a single API key; routing
  uses machine-local `project_path`.
- ed25519 keypairs are generated per agent and **never used** (private keys
  currently under `~/.codex/brainclaw/keys`).
- 2,000+ store files carry the OS username; worktree paths are absolute.
- No write-authority model exists for same-project-multi-machine (the
  signaling-vs-execution decision covered cross-*project* only). C4 cannot
  be answered without one.

Local incidents (2026-06-10) showing the same root: VS Code extension
inherited agent env → impersonation + cursor consumption; directory
presence (`~/.config/opencode`) minted a **trusted** identity; three
simultaneous claude-code instances shared one agent_id (loop slot auth
distinguishes nothing); a copilot worker committed as the human.

## The model

```
principal  prn_<id>   a HUMAN (or service account), optionally under org_<id>
                      (org = the premium billing/management unit)
actor      agt_<id>   an AGENT INSTANCE = (principal, machine, agent software)
                      keeps today's agt_ ids; gains principal_id, origin_id,
                      public key
origin     orig_<id>  a STORE REPLICA on a machine — minted once at
                      init/materialize, stored next to project.identity.json.
                      NOT os.hostname() (hostnames collide; one machine can
                      hold several replicas). host_id stays as metadata.
display    name       "claude-code" demoted to a label. Never a key.
```

### Write authority (answers C4's prerequisite)

- **Execution entities** (claims, sessions, runs, locks): origin-scoped,
  **single-writer**. Other origins materialize them read-only, tagged with
  their origin. Claims get eager push-on-write to the bus (piggybacked on
  the existing claim mutation path — still no daemon) for advisory
  cross-machine visibility; true atomic arbitration is deferred to the
  cloud dispatcher (Durable Object, premium) and local-first never blocks
  on it.
- **Memory entities** (decisions, traps, plans…): LWW by
  `(entity_rev, origin)`; conflicts surface as candidates, never silent
  overwrite.
- **Consequence for C4**: with partitioned authority, the **scalar
  `entity_rev` + origin tag suffices** — no vector clocks. Federation
  transfers are `(origin_id, seq)`-headed segment slices.

### Authn — the minimal dumb-bus guarantee

Activate the dormant ed25519 keys. `brainclaw cloud register` (already
specced in the cli-cloud plan) binds *actor public key → principal* once,
under the principal's API token (one token per human). Every
FederationMessage then carries `{principal_id, actor_id, origin_id, sig}`
over the envelope hash; the cloud verifies once and stamps
`verified_principal`; receivers trust the stamp. No PKI web. Routing moves
from `project_path` to `project_id` + channel.

### Authz

Trust moves from per-local-agent-doc to **per (principal, project)**
grants, distributed as a signed `members` projection (managed in the
Phase-2 dashboard, materialized locally like everything else). Local-only
operation is unchanged: principal defaults to an implicit `prn_local`.

### Privacy boundary

The federation export strips: `user` (OS username), absolute paths
(`worktree_path`, `related_paths` become repo-relative), pid/session
internals. `principal_id` replaces the username as human attribution.
Pairs with the J1 `doctor redact` decision.

## Identity acquisition (local prerequisite, pln#562)

Detection conflates three questions today; they split as follows:

| Question | Owner | Legitimate evidence |
|---|---|---|
| What is installed on this machine? | `agent-inventory` (single source) | disk presence — an **origin** attribute; doubles as the capability advertisement the cloud dispatcher needs |
| Who is calling? | `detectAiAgent` | process-scoped env markers ONLY — never directory presence; claimed identity sanity-checked *against* inventory |
| What trust? | explicit acts (human at setup, dispatcher at spawn), capped at contributor | never a read-path side effect |

## Migration (mostly additive)

1. `AgentIdentityDocument` += optional `principal_id`, `origin_id`
   (zod-optional — old docs parse).
2. `origin_id` minted lazily at first federation use; the v2 event envelope
   stays agnostic (origin added only to *exported* slices via segment
   headers — zero local cost).
3. Cursors and cloud inboxes re-keyed name → instance (one-time rename;
   cursors are caches).
4. Wire `isDuplicate` + a persisted `since` watermark for cloud pulls now
   (pre-federation bugfix — duplicates materialize on every session today).
5. `FederationMessage` v2: `project_id` + channel routing + signature
   block; `idempotency_key` survives unchanged.

## Open questions for this review

- **[CODEX]** Envelope/signature schema; `(origin_id, seq)` slice header
  format vs the event-log spec's checkpoint manifests; entity_rev semantics
  under origin-partitioned authority (any hole that re-requires vectors?).
- **[CODEX]** members-projection trust distribution: signature chain and
  revocation story.
- **[JUAN]** org model scope for v1 (implicit single-org? explicit org
  onboarding?); one API token per human vs per machine; whether claim
  eager-push is acceptable bus chatter on the free tier.
