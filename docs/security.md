# Security

brainclaw is designed to be safe by default.

## Security model

### No network access by default
The CLI does not need to call external services to function. The optional
supply-chain gate (see below) is the one feature that talks to a remote
service, and it is off until explicitly enabled.

### No telemetry
brainclaw does not collect or send usage data.

### No secret management
brainclaw is not a vault and should not be treated like one.

### Plain-text visibility
The storage model is intentionally inspectable.
That makes review easier, but it also means users must be careful about what they write and commit.

## Built-in safety behaviors

### Content scanning (scanText)

Whenever content is added to `.brainclaw/` brainclaw scans the text in three
layers:

1. **User-configured regex patterns** from `redaction.patterns`. The
   defaults catch words like `api_key`, `secret`, `token`, `password`.
2. **Structural detectors** for well-known token shapes — GitHub PATs
   (`ghp_`, `gho_`, `github_pat_…`), AWS access keys (`AKIA…`/`ASIA…`),
   Google API keys (`AIza…`), Slack tokens and webhooks, Stripe
   `sk_live_/sk_test_` keys, JWTs, PEM-encoded private keys, and URLs
   with embedded `user:password@host` credentials.
3. **Entropy detector** that flags high-Shannon-entropy substrings near
   a secret keyword (api_key/token/secret/password/auth/...). This
   catches custom-shaped keys the structural list does not enumerate.

In `security.mode: warn` matches surface as warnings; in
`security.strict_redaction: true` (or `security.mode: strict`) the same
matches block the write.

### Sensitive paths

When `security.block_sensitive_paths: true` (default), content that
references paths like `.env`, `secrets/`, `.git/`, or `node_modules/`
is flagged. `block_sensitive_paths` is the **enable-gate** for this layer;
the flagged level follows the same rule as every other signal — a `warn`
normally, escalating to `block` under `strict_redaction: true` (mode:
strict). It is not a standalone block toggle: in warn mode a sensitive-path
mention warns; in strict mode it blocks, uniformly with redaction, structural,
and entropy matches.

### Signal layers and levels

`scanText` runs four independent layers, each with its own enable-gate, and
they all share one level rule:

| Layer | Enable-gate | Level (warn mode / strict) |
|-------|-------------|----------------------------|
| Redaction patterns | `redaction.enabled` | warn / block |
| Structural detectors | `security.token_detection.enabled` | warn / block |
| Entropy detector | `security.token_detection.entropy.enabled` | warn / block |
| Sensitive paths | `security.block_sensitive_paths` | warn / block |

`strict_redaction: true` escalates **every** matched signal to `block`
uniformly; there is no per-layer level override. Excerpts in messages are
always irreversibly masked.

### Configuration

```yaml
security:
  mode: warn               # 'warn' or 'strict' — affects redaction scanning
  strict_redaction: false  # if true, blocks entries with sensitive content
  block_sensitive_paths: true
  token_detection:
    enabled: true          # turn off all structural + entropy detection
    entropy:
      enabled: true
      min_length: 32       # minimum substring length to consider
      min_entropy: 4.0     # minimum Shannon entropy (bits/char)
    detectors:             # per-detector override map; explicit false disables a detector
      aws_access_key: true
      jwt: true

redaction:
  enabled: true
  patterns:
    - '(?i)api[_-]?key'
    - '(?i)secret'
    - '(?i)token'
    - '(?i)password'
```

## Supply-chain pre-install gate

`brainclaw setup-security` enables a preinstall gate that intercepts
`npm`/`pnpm`/`yarn`/`pip`/`pip3` install commands and asks Socket.dev's
scoring service whether the requested packages are risky.

```
brainclaw setup-security --mode advisory    # default — warn-only
brainclaw setup-security --mode enforced    # block risky installs
```

### Advisory vs enforced

The mode determines what happens when the gate decides a package is
risky:

- **advisory** — verdicts are surfaced (printed warning, security trap
  created) but the install is *not* aborted.
- **enforced** — a `block` verdict aborts the install with a non-zero
  exit code.

The mode is read from `security.preinstall.mode` and can be overridden
per call with `brainclaw check-security --mode <advisory|enforced>`.

### Exit codes

`brainclaw check-security` emits exit codes that already encode the mode
decision, so wrapper scripts are mode-agnostic:

| Exit | Meaning                                                    |
|------|------------------------------------------------------------|
| 0    | pass — no risky packages                                   |
| 1    | warn — advisory-mode block, or warn-threshold verdict      |
| 2    | block — enforced-mode block; the wrapper aborts the install|

The wrapper scripts (`<.brainclaw/security/bin>/npm`, `pnpm`, `yarn`,
`pip`, `pip3` and their `.ps1` counterparts) call the CLI and react
purely to the exit code, so flipping advisory↔enforced is a config
change — no regeneration required.

### Composite scoring

Each package gets five sub-scores from Socket (supply-chain,
vulnerability, quality, maintenance, license) on a 0–100 scale. The
gate combines them into a single composite using configurable weights:

```yaml
security:
  preinstall:
    weights:
      supply_chain: 0.35
      vulnerability: 0.30
      quality: 0.15
      maintenance: 0.15
      license: 0.05
    thresholds:
      composite_pass: 70        # composite >= 70 → pass
      composite_warn: 50        # composite >= 50 but < 70 → warn; below → block
      supply_chain_block: 30    # hard block when supply_chain < 30
      vulnerability_block: 20   # hard block when vulnerability < 20
```

Weights are normalized to sum to 1.0 automatically — a config like
`{ supply_chain: 1, vulnerability: 1 }` is rescaled rather than
producing composites above 100. Thresholds are clamped to `[0,100]`
and `composite_warn` is capped at `composite_pass` so the verdict
function stays monotonic.

### Allowlist / denylist

```yaml
security:
  preinstall:
    allowlist:
      - npm:internal-pkg            # ecosystem-scoped
      - npm:axios@1.14.0            # exact version pin
      - lodash                       # bare name — any ecosystem, any version
    denylist:
      - npm:axios@1.14.1            # known-compromised version
      - pypi:bad-pkg
```

Matching is exact on each component. Bare names match by package name
only; an `ecosystem:` prefix scopes the match to that ecosystem;
appending `@version` (or `==version` for pip-style) requires an exact
version. The wildcard `@*` matches any version (useful for explicit
"any version" entries).

This is a hard tightening from the MVP: previously `denylist: ['lodash']`
matched any package whose purl contained the substring `lodash`, so
`react-lodash` was silently blocked. The new matcher requires exact
package-name equality.

### Package extraction sources

`check-security` can pull the list of packages from three places, which
may be combined:

- `--packages axios,express@1.2.3` — comma-separated specs
- `--requirements requirements.txt` — pip-style requirements file;
  recursive `-r` includes, env markers, and extras are handled
- `--lockfile package-lock.json` — npm package-lock (v1, v2, v3);
  scans top-level direct deps and devDeps

The wrappers auto-translate `npm install -r foo.txt` → `--requirements`,
skip filesystem paths and URL specs that aren't registry packages
(`./local-pkg`, `git+https://…`, `*.tgz`, `*.whl`), and handle the
common npm/pip flag conventions.

### Offline / fetch-error fallback

When the Socket call fails (network down, service unreachable), the
gate uses `security.preinstall.fallback_on_error`:

- `block` — fail closed regardless of mode
- `warn` — surface a warning, continue with whatever cached scores
  exist; if no cache exists the gate exits with code 1
- `pass`  — silent fall-through (the install proceeds)

Cached scores have a TTL of `cache_ttl_hours` (default 24) and live
in `.brainclaw/security/cache.json`.

## Recommended stance

- do not store secrets — even with detection, the safer move is to never
  write them
- review what gets committed
- keep machine-local observations machine-local when appropriate
- use stricter redaction settings in sensitive environments
- run `setup-security --mode advisory` first; flip to `enforced` once
  the team has gotten used to the verdicts

## Important nuance

brainclaw reduces hidden behavior, but it does not remove the need for
operational discipline. It warns; the team still decides what belongs
in shared memory.
