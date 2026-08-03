/**
 * pln#618 — shell-injection regression for Git revspecs built from a
 * controllable branch name.
 *
 * The stale-branch warning on bclaw_claim used to build its revspec by string
 * interpolation into an `execSync` shell command:
 *
 *     execSync(`git rev-list --count ${currentBranch}..${mainBranch}`)
 *
 * `currentBranch` comes from `git branch --show-current`, i.e. from whatever
 * ref the workspace happens to be on — and git ref names legally contain shell
 * metacharacters (`&`, `;`, `$`, `` ` ``, `(`, `)`). Checking out such a branch
 * turned a read-only warning into arbitrary command execution.
 *
 * PAYLOAD_BRANCH below is creatable as a real ref on both Windows (no chars
 * that NTFS rejects, since loose refs are files) and POSIX, and chains a
 * parasite command under BOTH shells:
 *   - cmd.exe splits on `&`  → runs `echo.PWNED..master`
 *   - POSIX sh splits on `;` → runs `touch PWNED` (`${IFS}` dodges git's
 *     no-space rule in ref names)
 *
 * Measured against the pre-fix code on win32: stdout was `PWNED..master`
 * instead of the commit count — the injected command ran, and parseInt of the
 * hijacked output was NaN, so the warning silently vanished too.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectCommitsBehindMainDetailed, type CommandResult } from '../../src/core/execution-context.js';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/** Git-legal ref name that chains a parasite command under cmd.exe and POSIX sh. */
const PAYLOAD_BRANCH = 'feat/pwn;touch${IFS}PWNED&echo.PWNED';
/** Commits master gets ahead of the payload branch, so the warning has a count to report. */
const COMMITS_AHEAD = 3;

function git(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function commit(cwd: string, name: string): void {
  fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', name);
}

/**
 * Build a repo where `master` is COMMITS_AHEAD commits ahead of the payload
 * branch, then check the payload branch out. Returns the ref name git actually
 * reports, so the test asserts on the real round-tripped value.
 */
function setupPayloadRepo(dir: string): string {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'checkout', '-q', '-b', 'master');
  commit(dir, 'base');

  const created = git(dir, 'checkout', '-q', '-b', PAYLOAD_BRANCH);
  assert.equal(created.status, 0, `payload ref must be creatable: ${created.stderr}`);
  commit(dir, 'payload-branch-work');

  git(dir, 'checkout', '-q', 'master');
  for (let i = 0; i < COMMITS_AHEAD; i += 1) commit(dir, `advance-${i}`);
  git(dir, 'checkout', '-q', PAYLOAD_BRANCH);

  const branch = git(dir, 'branch', '--show-current').stdout.trim();
  assert.equal(branch, PAYLOAD_BRANCH, 'ref round-trips through git unchanged');
  return branch;
}

/** Files an injected command would leave behind (`touch PWNED`, redirections…). */
function injectionSideEffects(dir: string): string[] {
  return fs.readdirSync(dir).filter((entry) => entry.toUpperCase().includes('PWNED'));
}

describe('git revspec shell injection (pln#618)', () => {
  let workspace: TestWorkspace;
  beforeEach(() => { workspace = createTestWorkspace({ prefix: 'bclaw-revspec-', currentAgent: 'claude-code' }); });
  afterEach(() => { workspace.cleanup(); });

  it('passes the revspec as ONE argv element, never assembled for a shell', () => {
    const seen: Array<{ command: string; args: string[] }> = [];
    const runner = (command: string, args: string[]): CommandResult => {
      seen.push({ command, args });
      return { status: 0, stdout: '2\n', stderr: '' };
    };

    detectCommitsBehindMainDetailed('/repo', PAYLOAD_BRANCH, runner);

    assert.ok(seen.length > 0, 'the runner was invoked');
    for (const call of seen) {
      assert.equal(call.command, 'git', 'command is the git binary itself, not a shell');
      const revspecs = call.args.filter((arg) => arg.includes(PAYLOAD_BRANCH));
      assert.equal(revspecs.length, 1, `revspec is exactly one argv element: ${JSON.stringify(call.args)}`);
      assert.ok(
        revspecs[0]!.startsWith(PAYLOAD_BRANCH),
        `metacharacters reach git verbatim, unescaped and unsplit: ${revspecs[0]}`,
      );
      assert.ok(
        revspecs[0]!.endsWith('..master') || revspecs[0]!.endsWith('..main'),
        `revspec keeps the range suffix: ${revspecs[0]}`,
      );
      // No argv element may be a shell invocation carrying the payload inline.
      assert.ok(
        !call.args.some((arg) => /^-(c|Command)$/i.test(arg)),
        'no shell -c / -Command wrapper',
      );
    }
  });

  it('counts commits correctly for a branch whose name carries shell metacharacters', () => {
    const branch = setupPayloadRepo(workspace.dir);

    const behind = detectCommitsBehindMainDetailed(workspace.dir, branch);

    assert.ok(behind, 'a reference branch was resolved');
    assert.equal(behind.branch, 'master');
    assert.equal(behind.count, COMMITS_AHEAD, 'git resolved the payload ref as a single revision');
    assert.deepEqual(injectionSideEffects(workspace.dir), [], 'no parasite command ran');
  });

  it('bclaw_claim reports the stale-branch warning without executing the payload', async () => {
    setupPayloadRepo(workspace.dir);

    const out = await executeMcpToolCall({
      name: 'bclaw_claim',
      args: { scope: 'src/revspec-target.ts', description: 'work on a hostile branch', agent: 'claude-code', advisory: true },
      cwd: workspace.dir,
    });

    assert.equal(out.response.isError ?? false, false, JSON.stringify(out.response));
    const text = out.response.content?.[0]?.text ?? '';
    // Pre-fix, cmd.exe hijacked stdout to "PWNED..master" → parseInt NaN → the
    // warning was dropped entirely. The count proves git parsed the revspec.
    assert.match(text, new RegExp(`${COMMITS_AHEAD} commit\\(s\\) behind master`), text);
    assert.ok(!text.includes('PWNED..master'), `hijacked shell output leaked into the response: ${text}`);
    assert.deepEqual(injectionSideEffects(workspace.dir), [], 'no parasite command ran');
  });

  it('keeps the warning working for an ordinary branch name', async () => {
    git(workspace.dir, 'init', '-q');
    git(workspace.dir, 'config', 'user.email', 'test@example.com');
    git(workspace.dir, 'config', 'user.name', 'Test User');
    git(workspace.dir, 'checkout', '-q', '-b', 'master');
    commit(workspace.dir, 'base');
    git(workspace.dir, 'checkout', '-q', '-b', 'feat/ordinary');
    git(workspace.dir, 'checkout', '-q', 'master');
    commit(workspace.dir, 'advance');
    git(workspace.dir, 'checkout', '-q', 'feat/ordinary');

    const behind = detectCommitsBehindMainDetailed(workspace.dir, 'feat/ordinary');
    assert.deepEqual(behind, { branch: 'master', count: 1 });

    const out = await executeMcpToolCall({
      name: 'bclaw_claim',
      args: { scope: 'src/ordinary-target.ts', description: 'ordinary branch', agent: 'claude-code', advisory: true },
      cwd: workspace.dir,
    });
    const text = out.response.content?.[0]?.text ?? '';
    assert.match(text, /1 commit\(s\) behind master/, text);
  });

  it('stays silent when HEAD is detached or git is unavailable', () => {
    // Not a git repo at all — must not throw, must not warn.
    assert.equal(detectCommitsBehindMainDetailed(workspace.dir, 'feat/whatever'), undefined);
    // On the reference branch itself there is nothing to report.
    assert.equal(detectCommitsBehindMainDetailed(workspace.dir, 'master'), undefined);
    assert.equal(detectCommitsBehindMainDetailed(workspace.dir, 'main'), undefined);
  });
});
