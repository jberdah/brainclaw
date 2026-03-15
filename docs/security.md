# Security

brainclaw is designed to be safe by default.

## Security model

### No network access
The CLI does not need to call external services to function.

### No telemetry
brainclaw does not collect or send usage data.

### No secret management
brainclaw is not a vault and should not be treated like one.

### Plain-text visibility
The storage model is intentionally inspectable.
That makes review easier, but it also means users must be careful about what they write and commit.

## Built-in safety behaviors

brainclaw warns when content appears sensitive, for example when text includes patterns such as:

- `api_key`
- `secret`
- `token`
- `password`

It can also warn about sensitive paths such as:

- `.env`
- `secrets/`

Redaction behavior is configurable in `config.yaml`:

```yaml
security:
  mode: warn               # 'warn' or 'strict'
  strict_redaction: false  # if true, blocks entries with sensitive content
  block_sensitive_paths: true
```

## Recommended stance

- do not store secrets
- review what gets committed
- keep machine-local observations machine-local when appropriate
- use stricter redaction settings in sensitive environments

## Important nuance

brainclaw reduces hidden behavior, but it does not remove the need for operational discipline.
It warns; the team still decides what belongs in shared memory.
