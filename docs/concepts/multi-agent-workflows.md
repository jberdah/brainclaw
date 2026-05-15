# Multi-Agent Workflows

brainclaw is built around a small set of memory primitives — **plans**, **claims**, **handoffs**, **decisions**, **traps**, and **runtime notes** — that work the same way whether you're orchestrating multiple agents in parallel right now or letting the next agent (or the next you) pick up the work next week.

This doc walks through four concrete scenarios. Pick the one that matches what you're doing.

---

## 1. Active orchestration — parallel work across agent instances

**Scenario** — you have a sequence of independent lanes and want several agents (same agent, different instances, or several different agents) to work on them in parallel.

**Walkthrough**:

1. Capture the work as plans, then group them into a sequence with explicit lane labels and dependencies:

   ```text
   bclaw_create(entity="plan", data={ text: "Refactor auth module", … })
   bclaw_create(entity="plan", data={ text: "Add e2e tests", … })

   # Then, via CLI or a follow-up call:
   brainclaw sequence create "auth-refactor-cycle" --items '[
     {"planId":"pln_aaa","rank":1,"lane":"refactor"},
     {"planId":"pln_bbb","rank":2,"lane":"tests","hard_after":["pln_aaa"]}
   ]' --status active
   ```

2. Dispatch the sequence — the dispatcher picks up the ready lanes (no `hard_after` blocking), creates one claim + worktree per lane, and routes inbox messages by `claim_id`:

   ```text
   bclaw_dispatch(intent="execute", agents=[<your agents>])
   ```

3. Each spawned worker runs in its own worktree (so concurrent edits don't collide), reads its inbox, and progresses the plan. Coordinator polls `bclaw_context(kind="board")` to follow progress.

4. As each lane lands a commit, merge it into master and release the claim. Lanes with `hard_after` unblock automatically once their predecessors are `done`.

**What the primitives do here**: claims isolate scope per lane, the sequence's `hard_after` graph orders the work, and worktrees give Git-level isolation so parallel commits don't conflict.

---

## 2. Agent switching — when an agent runs out of credits mid-task

**Scenario** — your active agent hits a credit/quota limit while a task is half-done. You want the next agent (a different model, a fresh instance, anything you have available) to resume cleanly without re-explaining the whole project.

**Walkthrough**:

1. Before the active agent shuts down, close out properly:

   ```text
   bclaw_session_end(narrative="Implemented X. Need to finish Y. Tests for Z still pending.")
   ```

   This snapshots the session, releases the active claims, and writes a handoff with the narrative + commit list.

2. Bring up the next agent (any compatible one). Its first call is `bclaw_work(intent="resume")`:

   ```text
   bclaw_work(intent="resume")
   ```

   This returns the session context: open plans, recent decisions, active constraints, known traps, the latest handoff narrative, and any unfinished claims it can adopt.

3. The new agent reads the handoff, picks up the right plan, and either creates a fresh claim on the same scope or adopts the existing one:

   ```text
   bclaw_work(intent="execute", planId="pln_…", scope="src/...")
   ```

4. From here on it's a normal session — the new agent has all the context the previous one had.

**What the primitives do here**: the handoff carries the narrative and the file delta, the session record carries the runtime context, and shared memory (decisions, constraints, traps) means the new agent doesn't relearn what the previous one already knows.

---

## 3. Project recovery — returning to a project after weeks

**Scenario** — you (or an agent on your behalf) come back to a project after a couple of weeks. You don't remember exactly where things stood. You want to ramp back up in a few minutes, not an afternoon.

**Walkthrough**:

1. From the project root, ask any compatible agent to load context with the canonical facade:

   ```text
   bclaw_work(intent="resume")
   ```

   You get back: in-progress plans, blocked plans, decisions taken since you left, active constraints, known traps, recent handoffs, and a session continuity hint (where the last session left off).

2. If you want a narrower view focused on one area:

   ```text
   bclaw_context(kind="memory", path="src/auth", profile="briefing")
   ```

3. Capture the things you remember in the moment — even rough — as runtime notes. They live in memory and can be promoted later to durable decisions or traps:

   ```text
   bclaw_create(entity="runtime_note", data={ text: "Token rotation logic was the next thing to ship" })
   ```

4. Pick the next plan, claim its scope, and start working. The agent has everything it needs.

**What the primitives do here**: durable memory means decisions and constraints survive long absences, the session continuity record bridges the gap between runs, and runtime notes give a low-friction way to capture half-formed ideas as they come back to you.

---

## 4. Team async — multiple humans and agents on the same project

**Scenario** — two or more people work on the same project, possibly with their own agents. Everyone needs to see the same plans, the same constraints, the same decisions, without constant Slack pings.

**Walkthrough**:

1. Whenever someone takes a non-trivial decision (architecture, library choice, naming convention), capture it once:

   ```text
   bclaw_create(entity="decision", data={ text: "Use OAuth 2.0 with PKCE", outcome: "approved" })
   bclaw_create(entity="constraint", data={ text: "All auth endpoints must rate-limit", category: "security" })
   bclaw_create(entity="trap", data={ text: "Don't import from src/legacy/", severity: "high" })
   ```

   These become visible to every agent (and every teammate's agent) on the next `bclaw_context` call.

2. When someone starts a non-trivial chunk of work, claim its scope so others can see it:

   ```text
   bclaw_work(intent="execute", scope="src/auth", task="Token rotation rework")
   ```

   The agent board (`bclaw_context(kind="board")` or `brainclaw agent-board`) now shows that scope as taken — anyone considering the same area sees the claim and either coordinates or picks something else.

3. When work is ready for review, hand it off explicitly. The handoff includes the file delta, the narrative, and any open questions:

   ```text
   bclaw_coordinate(intent="review", task="Auth refactor ready for review", scope="src/auth")
   ```

4. Reviewers pick up the handoff via inbox (`bclaw_read_inbox`) and respond either by accepting + closing it, or by sending back fixes through the same coordination loop.

**What the primitives do here**: shared memory means every teammate's agent operates with the same constraints and traps, claims prevent double-work even without coordination meetings, and handoffs replace ad-hoc "hey, can you look at this?" pings with auditable artifacts.

---

## How the four scenarios share the same model

Notice that the four walkthroughs above use the **same primitives**, just composed differently:

| Primitive | Active orchestration | Agent switching | Project recovery | Team async |
|---|---|---|---|---|
| **plan** | unit of work in a lane | what the next agent picks up | what you ramp back into | what teammates see in the board |
| **claim** | scope lock per lane | snapshotted on session_end, adoptable later | shows what was in flight | prevents teammates from double-editing |
| **handoff** | between sequential lanes | carries the narrative + delta | bridges across the gap | replaces "ping me when ready" |
| **decision / constraint / trap** | guides every spawned worker | survives the credit-limit cutover | reminds you of past choices | propagates team knowledge |
| **runtime_note** | per-lane observations | quick captures before shutdown | half-formed thoughts on return | informal observations to share |

You don't pick a "mode" up front. You compose the primitives in whatever way fits the moment, and brainclaw keeps them durable across all of it.

---

## Next reads

- [memory.md](memory.md) — what counts as memory and how it's organized
- [plans-and-claims.md](plans-and-claims.md) — coordination layer in depth
- [loop-engine.md](loop-engine.md) — structured multi-turn protocols (review loops, ideation, etc.)
- [dispatch-lifecycle.md](dispatch-lifecycle.md) — what actually happens when a dispatch goes wrong: 6-entity dance, brief-ack sentinel, stdout/stderr logs, observability decision tree
- [memory-staleness.md](memory-staleness.md) — how brainclaw signals when stored items may be outdated
- [../integrations/overview.md](../integrations/overview.md) — connecting your specific agent
