# OpenClaw Adapter Guide

This adapter helps convert OpenClaw runtime traces into Team Memory candidates.

## Supported Inputs

- Runtime event file: JSON array of events.
- Runtime session import: events filtered by `metadata.session` from `.memory/runtime/`.

## Basic Usage

```bash
team-memory adapter-openclaw-import ./openclaw-events.json
team-memory adapter-openclaw-import --session sess_42
```

## Dry-Run Workflow

Use `--dry-run` to preview what would be ingested without writing any files:

```bash
team-memory adapter-openclaw-import ./openclaw-events.json --dry-run
```

Dry-run is useful for CI checks and for validating mapping quality before modifying `.memory/inbox/`.

## Event Mapping

Current mapping converts events into reflective candidate types:

- `risk_detected` -> `trap`
- `handoff_requested` -> `handoff`
- `observation` -> `decision`
- `constraint_detected` -> `constraint`

If an event type is unknown, it defaults to `decision`.

## Recommended Team Flow

1. Import events from file or session.
2. Run `team-memory review --prioritized`.
3. Curators process with `team-memory accept` or `team-memory reject`.
4. Use `team-memory doctor` or `team-memory doctor --json` to monitor quality.
