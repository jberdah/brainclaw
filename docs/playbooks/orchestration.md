# Asynchronous Orchestrator Playbook

This playbook is designed for Manager/Dispatcher AI Agents steering multi-agent projects using Brainclaw. It provides a structured approach to managing complex, asynchronous workflows, ensuring efficient delegation, execution, and review across multiple agents.

## Step 1: Create a Plan

Before delegating any work, establish a clear and actionable formulation of the required tasks.

- Define a top-level Plan using the canonical `bclaw_create(entity="plan", data={…})` tool. (`bclaw_work` does not create plans — when none is active it returns a `nextActions` hint pointing to `bclaw_create`.)
- Break down the overarching project goal into manageable sub-steps using the `bclaw_add_step` tool.
- Ensure that each step has a clear description, expected outcome, and (optionally) an estimated effort. A well-defined plan acts as the ground truth for downstream agents.

## Step 2: Create Sequences for Parallel Work Lanes

When tasks are independent or can be parallelized, organize the plan steps into sequences to maximize throughput.

- Use the `bclaw_create_sequence` tool to map steps into sequence lanes.
- Define `hard_after` dependencies if certain steps strictly require others to complete first, or `soft_after` for advisory ordering.
- Grouping tasks into distinct lanes ensures execution agents run in parallel safely and are not unnecessarily blocked.

## Step 3: Dispatch Work

With the plan and sequences established, assign the work to execution agents.

- **Sequence-driven execution:** Use `bclaw_dispatch(intent="execute")` to parallelize plans across your defined sequence lanes automatically.
- **Direct orchestration:** For ad-hoc delegation, use `bclaw_coordinate(intent="assign")` to assign specific tasks to target agents. This seamlessly generates the necessary claims and dispatch briefs.
- **Reviews & Loops:** To open a structured review process on completed work, use `bclaw_coordinate(intent="review", open_loop=true)`. The reviewer's verdict is harvested from its `LANE-RESULT.json` (`review_verdict`) and the loop **auto-closes on approve** — no manual `complete_turn`/`advance` round-trip to close the approve path (pln#628 Focus 4B).
- Use `bclaw_dispatch_status` to verify worker liveness, examine log tails, and ensure dispatches are progressing healthily.

## Step 4: Manage the Inbox

As downstream execution agents interact with their assignments, they will emit statuses, request reviews, or supply handoffs back to the orchestrator.

- Routinely call `bclaw_read_inbox` to fetch incoming messages, status updates, and peer requests.
- Acknowledge received messages using `bclaw_ack_message` after processing to keep the inbox clean.
- Review handoffs and lifecycle events, transitioning the overarching plan steps (e.g., utilizing `bclaw_complete_step`) once execution meets the expected criteria.
- If an agent is blocked, read their action required prompts from the inbox and respond utilizing `bclaw_assignment_action` or by steering them in a new direction.