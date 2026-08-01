import fs from 'node:fs';
import path from 'node:path';
import { memoryExists } from '../core/io.js';

export interface InstallHooksOptions {
  force?: boolean;
}

export function runInstallHooks(options: InstallHooksOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) {
    console.error('Error: no .git/ directory found. Is this a Git repository?');
    process.exit(1);
  }

  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = path.join(hooksDir, 'pre-commit');
  if (fs.existsSync(hookPath) && !options.force) {
    console.error(`Error: pre-commit hook already exists at ${hookPath}`);
    console.error('Use --force to overwrite.');
    process.exit(1);
  }

  fs.writeFileSync(hookPath, generateHookScript(), { encoding: 'utf-8', mode: 0o755 });
  console.log(`✔ pre-commit hook installed at ${hookPath}`);
  console.log('  Checks: sensitive content in .brainclaw/ + active constraint violations.');
  console.log('  To bypass (not recommended): git commit --no-verify');

  const postMergePath = path.join(hooksDir, 'post-merge');
  if (!fs.existsSync(postMergePath) || options.force) {
    fs.writeFileSync(postMergePath, generatePostMergeScript(), { encoding: 'utf-8', mode: 0o755 });
    console.log(`✔ post-merge hook installed at ${postMergePath}`);
    console.log('  Auto-releases claims whose scope was touched by the merge.');
  }

  // Claude Code preToolUse hook (claim-warning)
  const claudeHookPath = path.join(hooksDir, 'claude-pre-tool.sh');
  if (!fs.existsSync(claudeHookPath) || options.force) {
    fs.writeFileSync(claudeHookPath, generateClaudePreToolScript(), { encoding: 'utf-8', mode: 0o755 });
    console.log(`✔ Claude Code preToolUse hook generated at ${claudeHookPath}`);
  }
  // pln#636 C1 second half (review F2) — GENERATION IS NOT ACTIVATION. This step
  // used to only print instructions, which is why the hook was dead even for
  // operators who ran the command: a repaired script nobody wires up is still
  // dead. The Codex writer has owned `.codex/hooks.json` since v1.17.0; this
  // brings the Claude surface to the same standard.
  const activation = activateClaudePreToolHook(gitRoot, claudeHookPath);
  switch (activation.status) {
    case 'activated':
      console.log(`✔ PreToolUse hook activated in ${activation.settingsPath}`);
      console.log('  Advisory-only (never blocks): it adds context, it cannot deny a write.');
      break;
    case 'already_active':
      console.log(`✔ PreToolUse hook already active in ${activation.settingsPath}`);
      break;
    case 'failed':
      console.log(`⚠ Could not activate the PreToolUse hook automatically: ${activation.reason}`);
      console.log('  Add this to .claude/settings.json by hand:');
      console.log('    { "hooks": { "PreToolUse": [ { "matcher": "Edit|Write|MultiEdit|NotebookEdit",');
      console.log(`        "hooks": [ { "type": "command", "command": "${toPosixPath(claudeHookPath)}" } ] } ] } }`);
      break;
  }
}

/** Hook scripts are invoked through a shell, so the command is always POSIX-style. */
function toPosixPath(p: string): string {
  return p.split('\\').join('/');
}

/**
 * The tools whose `tool_input` exposes a concrete file path.
 *
 * `Bash` is deliberately absent: a shell command's file footprint is not
 * statically knowable, so it is `unverifiable`, never a guess. The pre-repair
 * matcher included it, which was one source of the noise that made the hook
 * worth ignoring.
 */
const CLAUDE_PRE_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

interface ClaudeHookEntry {
  type?: string;
  command?: string;
}

interface ClaudeMatcherEntry {
  matcher?: string;
  hooks?: ClaudeHookEntry[];
}

export type ActivateHookResult =
  | { status: 'activated' | 'already_active'; settingsPath: string }
  | { status: 'failed'; reason: string; settingsPath: string };

/**
 * Merge the PreToolUse entry into `.claude/settings.json`, additively.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION, which matters more here than anywhere else in
 * this file: that file holds the operator's own permission allow-list, and
 * clobbering it would be a far worse outcome than an unactivated advisory. So
 * every unknown key is preserved, a pre-existing PreToolUse array is appended
 * to rather than replaced, and anything unparseable is left strictly untouched
 * with a manual instruction printed instead (trp_5f342186: a hook mechanism may
 * never be the thing that destroys work).
 *
 * Idempotent: re-running finds the existing command and reports `already_active`.
 */
export function activateClaudePreToolHook(gitRoot: string, hookPath: string): ActivateHookResult {
  const settingsPath = path.join(gitRoot, '.claude', 'settings.json');
  const command = toPosixPath(hookPath);

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'failed', reason: 'settings.json is not a JSON object', settingsPath };
      }
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      // Refusing to touch a file we cannot parse is the whole point: rewriting it
      // would silently drop the operator's permission list.
      return {
        status: 'failed',
        reason: `settings.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        settingsPath,
      };
    }
  }

  const hooksSection = (typeof settings.hooks === 'object' && settings.hooks !== null && !Array.isArray(settings.hooks))
    ? settings.hooks as Record<string, unknown>
    : {};
  const preToolUse: ClaudeMatcherEntry[] = Array.isArray(hooksSection.PreToolUse)
    ? hooksSection.PreToolUse as ClaudeMatcherEntry[]
    : [];

  const alreadyActive = preToolUse.some((entry) =>
    entry?.hooks?.some((h) => typeof h?.command === 'string' && toPosixPath(h.command) === command));
  if (alreadyActive) return { status: 'already_active', settingsPath };

  const next = {
    ...settings,
    hooks: {
      ...hooksSection,
      PreToolUse: [
        ...preToolUse,
        { matcher: CLAUDE_PRE_TOOL_MATCHER, hooks: [{ type: 'command', command }] },
      ],
    },
  };

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      settingsPath,
    };
  }
  return { status: 'activated', settingsPath };
}

/**
 * Claude Code PreToolUse advisory hook (pln#636 C1, mechanism per cst_38effd52).
 *
 * THE MECHANISM MATTERS, AND THE PREVIOUS VERSION HAD IT WRONG THREE WAYS:
 *
 * 1. It read the tool name from `CLAUDE_TOOL_NAME` in the environment. Claude
 *    Code delivers a JSON payload on **stdin**; that env var does not exist, so
 *    the hook exited before doing anything — dead on arrival.
 * 2. It wrote its advisory to **stderr with exit 0**. Per the documented host
 *    contract, stderr at exit 0 is NOT surfaced to the model (only exit 2 feeds
 *    stderr to Claude, and exit 2 BLOCKS the tool — unacceptable for an
 *    advisory). So even a hook fixed for (1) would have spoken into the void.
 *    The only non-blocking channel to the model is
 *    `hookSpecificOutput.additionalContext` on **stdout** with exit 0.
 * 3. It shelled out to the CLI (`execSync brainclaw claim list`) on every write,
 *    and deduped through one project-global marker, so one agent's warning
 *    silenced every other agent.
 *
 * Advisory-only is non-negotiable (trp_5f342186 — a hook cascade destroyed
 * work): `permissionDecision` is always `allow`, the exit code is always 0.
 *
 * SCOPE LIMIT, STATED HONESTLY: this version answers "do you hold ANY active
 * claim of your own?", not "are you writing outside your claim's scope". Real
 * scope awareness needs the scope grammar (pln#636 C0-a) — 42.4% of real claim
 * scopes are not path-matchable (cst_22ebb103), so a path comparison written
 * today would false-accuse on nearly half of them.
 *
 * Guarded by tests/unit/guidance-engine-consistency.test.ts.
 */
function generateClaudePreToolScript(): string {
  return `#!/bin/sh
# brainclaw Claude Code PreToolUse hook (advisory-only)
# Generated by: brainclaw install-hooks
# Contract: reads a JSON payload on stdin, replies with JSON on stdout, and
# ALWAYS exits 0. stderr is deliberately unused: Claude Code does not surface it
# to the model at exit 0 (cst_38effd52).
exec node -e "
const fs = require('fs');
const path = require('path');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { process.exit(0); }

let payload;
try { payload = JSON.parse(raw); } catch (e) { process.exit(0); }

// Only STRUCTURED writes expose a concrete file path. A shell command's file
// footprint is not statically knowable, so it stays unverifiable — never guessed.
const toolName = (payload && payload.tool_name) || '';
if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].indexOf(toolName) === -1) process.exit(0);

// Read the store directly; spawning the CLI per edit was the third defect.
var active = [];
try {
  var claimsDir = path.join(process.cwd(), '.brainclaw', 'coordination', 'claims');
  var walk = function (dir) {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var full = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) { walk(full); continue; }
      if (entries[i].name.slice(-5) !== '.json') continue;
      try {
        var claim = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (claim && claim.status === 'active') active.push(claim);
      } catch (e) { /* skip an unreadable claim */ }
    }
  };
  walk(claimsDir);
} catch (e) { process.exit(0); }

// Identity-aware: only THIS agent's claims count. Another agent holding a claim
// says nothing about whether you hold one.
var me = (process.env.BRAINCLAW_AGENT_ID || process.env.BRAINCLAW_AGENT_NAME || process.env.BRAINCLAW_AGENT || '').trim();
var mine = me ? active.filter(function (c) { return c.agent_id === me || c.agent === me; }) : active;
if (mine.length > 0) process.exit(0);

// Dedup PER AGENT, not once per project.
try {
  var runtimeDir = path.join(process.cwd(), '.brainclaw', 'coordination', 'runtime');
  var slug = (me || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  var mark = path.join(runtimeDir, 'claim-advisory-' + slug + '.mark');
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (fs.existsSync(mark) && Date.now() - fs.statSync(mark).mtimeMs < 2 * 60 * 60 * 1000) process.exit(0);
  fs.writeFileSync(mark, String(Date.now()));
} catch (e) { /* dedup is best-effort: speaking twice beats crashing */ }

// The ONLY non-blocking channel to the model. permissionDecision stays 'allow'.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    additionalContext: '[brainclaw] Editing without an active claim of your own. Claim the scope so parallel agents do not collide. Advisory only: this write is proceeding.',
  },
}));
process.exit(0);
"
`;
}

function generatePostMergeScript(): string {
  return `#!/bin/sh
# brainclaw post-merge hook
# Auto-releases claims whose scope overlaps with files changed by the merge
# Generated by: brainclaw install-hooks

BCLAW_CMD=""
if command -v brainclaw >/dev/null 2>&1; then
  BCLAW_CMD="brainclaw"
elif command -v bclaw >/dev/null 2>&1; then
  BCLAW_CMD="bclaw"
else
  BCLAW_CMD="npx --no brainclaw"
fi

$BCLAW_CMD release-claims --from-git-diff 2>/dev/null || true
$BCLAW_CMD worktree clean 2>/dev/null || true
`;
}

function findGitRoot(cwd: string): string | undefined {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function generateHookScript(): string {
  // Use node directly to avoid sh.exe pipe issues on Windows (SIGPIPE).
  // The script is a self-contained node -e that runs both checks.
  return `#!/bin/sh
# brainclaw pre-commit hook — generated by brainclaw install-hooks
# Runs via node to avoid sh.exe SIGPIPE issues on Windows.
exec node -e "
const { execSync } = require('child_process');
const staged = execSync('git diff --cached --name-only', { encoding: 'utf-8' }).trim();
if (!staged) process.exit(0);

// Check 1: reject staged .brainclaw/ files
const brainclawFiles = staged.split('\\\\n').filter(f => f.startsWith('.brainclaw/'));
if (brainclawFiles.length > 0) {
  process.stderr.write('\\\\nbrainclaw: .brainclaw/ files are staged — blocked.\\\\n');
  brainclawFiles.forEach(f => process.stderr.write('  ' + f + '\\\\n'));
  process.stderr.write('  Fix: git reset HEAD .brainclaw/\\\\n\\\\n');
  process.exit(1);
}

// Check 2: active constraint violations
try {
  execSync('brainclaw check-constraints --staged', { stdio: 'inherit' });
} catch (e) {
  if (e.status) process.exit(e.status);
}
" 2>&1 || exit $?
`;
}
