# OpenClaw Adapter Guide

This adapter helps convert OpenClaw runtime traces into brainclaw candidates.

## Supported Inputs

- Runtime event file: JSON array of events.
- Runtime session import: events filtered by `metadata.session` from `.brainclaw/runtime/`.

## Basic Usage

```bash
brainclaw adapter-openclaw-import ./openclaw-events.json
brainclaw adapter-openclaw-import --session sess_42
```

## Dry-Run Workflow

Use `--dry-run` to preview what would be ingested without writing any files:

```bash
brainclaw adapter-openclaw-import ./openclaw-events.json --dry-run
```

Dry-run is useful for CI checks and for validating mapping quality before modifying `.brainclaw/inbox/`.

## Event Mapping

Current mapping converts events into reflective candidate types:

- `risk_detected` -> `trap`
- `handoff_requested` -> `handoff`
- `observation` -> `decision`
- `constraint_detected` -> `constraint`

If an event type is unknown, it defaults to `decision`.

## Recommended Team Flow

1. Import events from file or session.
2. Run `brainclaw review --prioritized`.
3. Curators process with `brainclaw accept` or `brainclaw reject`.
4. Use `brainclaw doctor` or `brainclaw doctor --json` to monitor quality.
