# Plans and Claims

Plans and claims are where brainclaw starts to feel less like a note system and more like a coordination layer.

## Plans

Plans provide a shared view of intended work.

They help teams and agents answer questions like:

- what are we trying to ship?
- what is in progress?
- what is blocked?
- what is done?
- who is responsible right now?

### Plan statuses

| Status | Meaning |
|--------|---------|
| `todo` | Not started yet |
| `in_progress` | Actively being worked on |
| `done` | Completed |
| `blocked` | Waiting on something external |
| `dropped` | Dropped |

### Creating plans

```bash
brainclaw plan create "implement login flow"
brainclaw plan create "refactor auth module" --priority high --estimate 120
```

The `--estimate` flag accepts a **positive integer in minutes**. Example: `--estimate 30` means 30 minutes, `--estimate 120` means 2 hours.

### Updating plans

```bash
brainclaw plan update <id> --status in_progress
brainclaw plan update <id> --status done --actual-effort 45min
```

When marking a plan `in_progress` for the first time, `started_at` is automatically recorded.
When marking a plan `done`, `completed_at` is automatically recorded.

### Plan steps

Plans can have sub-steps for multi-phase work:

```bash
brainclaw add-step <plan-id> "write unit tests"
brainclaw add-step <plan-id> "update docs"
brainclaw complete-step <plan-id> <step-index>
```

Steps show up in `brainclaw context` and `brainclaw board` so other agents and humans can see granular progress.

### Estimation and calibration

When both `estimated_effort` and `actual_effort` are present on completed plans, brainclaw can compute an accuracy report:

```bash
brainclaw estimation-report
brainclaw estimation-report --agent my-agent
```

This shows a ratio chart (actual / estimate) and a calibration hint:

```
task with estimate      est:30min  actual:45min  [ratio:1.5x]
[0.0x    ░░░░░░░░░░│████████████████████░░░░░░░░░░░░░░░░░  2.0x+]
                                                        OVER +50%
```

A ratio below 1.0 means the task finished faster than expected (early). Above 1.0 means it took longer (over).

## Claims

Claims make current ownership explicit.

A claim can represent:

- a file
- a folder
- a feature area
- a work scope linked to a plan item

Claims help reduce collisions when multiple humans or agents work in parallel.

### Creating claims

```bash
brainclaw claim create "refactoring auth module" --scope src/auth/
brainclaw claim create "updating docs" --scope docs/ --ttl 4h
brainclaw claim create "fixing login bug" --scope src/auth/ --plan <plan-id>
```

The `--ttl` flag sets a time-to-live for the claim. After expiry, the claim is no longer considered active by other agents. Valid formats: `30min`, `2h`, `1d`.

### Listing and releasing claims

```bash
brainclaw claim list
brainclaw claim release <id>
```

`claim list` shows who holds each claim and whether it is still active. If a claim has a `session_id`, the last 8 characters are shown so you can correlate with the agent session that created it.

## Why claims matter

Without claims, multiple agents can easily touch the same area at once and generate conflicting changes.
Claims are not necessarily hard file locks.
They are a shared coordination signal.

## Recommended workflow

1. create a plan item
2. claim the target scope
3. work on the implementation
4. update the plan status
5. release the claim when done or blocked
6. create a handoff if another actor should continue

## Session hygiene

Before finishing a session, always:

- release active claims: `brainclaw claim release <id>`
- update plan items: `brainclaw plan update <id> --status done`
- or use `brainclaw session-end --auto-release` to clean up automatically

`session-end --auto-release` releases all claims held by the current agent and marks any `in_progress` plans as needing attention.

## Plans + claims together

Plans describe what should happen.
Claims describe who is currently working where.

That combination is much more useful than either one alone.
