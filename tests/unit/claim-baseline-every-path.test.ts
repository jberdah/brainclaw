/**
 * trp#1292 — every claim-CREATION path must stamp the baseline.
 *
 * ## Round 1 (1.19.1): the defect
 *
 * `base_sha` was stamped from exactly one function — `acquireClaimScope` — that
 * nothing user-facing calls. Real creation paths build their claim inline and call
 * `saveClaim` directly, so no real claim had a baseline and the pln#636 C2
 * conformity reconcile was inert. Two shipped feature PRs did nothing.
 *
 * ## Round 2: the GUARD I shipped for it was also holed
 *
 * An ideation critic reviewed the round-1 guard and found four escapes. It was a
 * regex over `saveClaim({`, so:
 *
 *  1. `const c = {…}; saveClaim(c)` — an identifier argument — was invisible.
 *  2. Worse, the scan SKIPPED the four already-listed files, so a fifth creator
 *     added inside `mcp.ts` or `claims.ts` would never be seen.
 *  3. The "does this module call the helper?" assertion was module-wide, so
 *     `core/claims.ts` passed merely because `claimBaselineFields` is DEFINED there.
 *  4. It ignored `{...defaults, …}` creation, aliased imports, and non-`.ts` files.
 *
 * And the hole was not theoretical: `commands/watch.ts` turned out to be a FIFTH
 * creation path (auto-claim on file change) that assigns its literal to a variable
 * — missed by the round-1 fix AND by its guard.
 *
 * ## So this version parses the AST
 *
 * Every `saveClaim` / `saveClaimUnlocked` call in `src/` is located, its first
 * argument RESOLVED (object literal, or identifier traced back to its
 * declaration), classified `create` vs `update`, and matched against an explicit
 * inventory below. A new or reclassified callsite fails until someone states what
 * it is — which is the property the regex version only pretended to have.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repo root not found from ${import.meta.dirname}`);
}

const SRC = path.join(findRepoRoot(), 'src');
const PERSIST_FNS = new Set(['saveClaim', 'saveClaimUnlocked']);

type Kind = 'create' | 'update';

interface Callsite {
  file: string;
  line: number;
  fn: string;
  kind: Kind;
  /** True when the resolved claim object carries the baseline spread. */
  stamped: boolean;
}

/** Walk every .ts file under src/. */
function sourceFiles(dir: string = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });
}

/** Nearest enclosing function-like scope, for scope-aware variable resolution. */
function enclosingScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur)
      || ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur)
    ) return cur;
    cur = cur.parent;
  }
  return node.getSourceFile();
}

/** Find `name`'s initializer, searching the nearest scope first, then the file.
 *  WHY SCOPE-FIRST: `core/claims.ts` has ten `saveClaimUnlocked(claim, cwd)` calls
 *  in different functions, all using the name `claim`. A file-wide search resolves
 *  every one of them to whichever declaration the walk happened to visit last —
 *  which silently misclassified acquireClaimScope's creation as an update in the
 *  first draft of this very test. */
function findInitializer(name: string, from: ts.Node): ts.Expression | undefined {
  const search = (root: ts.Node): ts.Expression | undefined => {
    let hit: ts.Expression | undefined;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
        hit = n.initializer;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(root);
    return hit;
  };
  return search(enclosingScope(from)) ?? search(from.getSourceFile());
}

/** Is this expression (or the variable it names) a `claimBaselineFields(...)` result? */
function isBaselineExpression(expr: ts.Expression, from: ts.Node): boolean {
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text === 'claimBaselineFields';
  }
  if (ts.isIdentifier(expr)) {
    const init = findInitializer(expr.text, from);
    return init !== undefined && ts.isCallExpression(init) && ts.isIdentifier(init.expression)
      && init.expression.text === 'claimBaselineFields';
  }
  return false;
}

/** Does this object literal apply the baseline?
 *  Accepts BOTH `...claimBaselineFields(cwd)` and `...baseline` where `baseline`
 *  was pre-computed from it — `createCoordinatorClaim` deliberately hoists the
 *  call out of the lock, so refusing the hoisted form would flag correct code. */
function stampsBaseline(obj: ts.ObjectLiteralExpression, from: ts.Node): boolean {
  return obj.properties.some((p) =>
    (ts.isSpreadAssignment(p) && isBaselineExpression(p.expression, from))
    || (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'base_sha'));
}

/** Does this literal spread an EXISTING claim (→ update rather than creation)? */
function spreadsExistingClaim(obj: ts.ObjectLiteralExpression, from: ts.Node): boolean {
  return obj.properties.some((p) =>
    ts.isSpreadAssignment(p)
    && ts.isIdentifier(p.expression)
    && !isBaselineExpression(p.expression, from));
}

/**
 * Resolve a call's first argument to the object literal that produced it.
 *
 * Handles the form the regex guard could not see: an identifier traced back to
 * its declaration. That is exactly how `watch.ts` and `acquireClaimScope` build
 * their claims — and how they stayed invisible.
 */
function resolveClaimObject(arg: ts.Expression, from: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(arg)) return arg;
  if (!ts.isIdentifier(arg)) return undefined;
  const init = findInitializer(arg.text, from);
  return init && ts.isObjectLiteralExpression(init) ? init : undefined;
}

function collectCallsites(): Callsite[] {
  const out: Callsite[] = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf-8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
    const rel = path.relative(SRC, file).split(path.sep).join('/');

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && PERSIST_FNS.has(node.expression.text)) {
        const fn = node.expression.text;
        const arg = node.arguments[0];
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (arg) {
          const obj = resolveClaimObject(arg, node);
          // Unresolvable argument (a parameter, a call result) is treated as an
          // UPDATE: it persists a claim that already exists. Deliberate — but the
          // inventory below still pins it, so a creation dressed that way fails.
          const kind: Kind = obj && !spreadsExistingClaim(obj, node) ? 'create' : 'update';
          out.push({ file: rel, line, fn, kind, stamped: obj ? stampsBaseline(obj, node) : false });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

/**
 * The CREATION sites, stated deliberately. Line numbers are intentionally absent
 * — they churn on every edit and would make this a maintenance tax rather than a
 * guard. What is pinned is the SET of files that create claims, and that each
 * creation carries the baseline.
 */
const EXPECTED_CREATION_FILES = new Set([
  'commands/mcp.ts',                 // bclaw_work(intent="execute") — the protocol's entry point
  'commands/mcp-write-claims.ts',    // bclaw_claim
  'commands/claim.ts',               // CLI `claim create`
  'commands/watch.ts',               // auto-claim on file change (the 5th path, found by review)
  'core/claims.ts',                  // acquireClaimScope + createCoordinatorClaim
]);

describe('trp#1292 — the claim baseline reaches every creation path (AST)', () => {
  it('resolves callsites at all (guard against the guard going blind)', () => {
    const sites = collectCallsites();
    assert.ok(sites.length >= 10, `expected the real callsite inventory, got ${sites.length}`);
    assert.ok(sites.some((s) => s.kind === 'create'), 'no creation site resolved — the AST walk broke');
  });

  it('EVERY creation site stamps the baseline', () => {
    // The assertion the regex version could not make: it is per-CALLSITE, not
    // per-module, so a file cannot pass merely because the helper appears
    // somewhere else in it.
    const unstamped = collectCallsites()
      .filter((s) => s.kind === 'create' && !s.stamped)
      .map((s) => `${s.file}:${s.line} (${s.fn})`);
    assert.deepEqual(
      unstamped, [],
      `these claim-CREATION callsites do not carry the baseline, so pln#636 C2 is inert for the claims they create:\n${unstamped.join('\n')}`,
    );
  });

  it('creation happens only in the files we expect', () => {
    // A sixth creation path — in a new file OR inside an already-listed one —
    // surfaces here instead of shipping silently. Round 1 skipped listed files
    // entirely, which is how watch.ts stayed invisible.
    const unexpected = [...new Set(
      collectCallsites().filter((s) => s.kind === 'create').map((s) => s.file),
    )].filter((f) => !EXPECTED_CREATION_FILES.has(f));
    assert.deepEqual(
      unexpected, [],
      `new claim-creation file(s). Add ...claimBaselineFields(cwd) and list them in EXPECTED_CREATION_FILES:\n${unexpected.join('\n')}`,
    );
  });

  it('every expected creation file still creates (the list cannot rot)', () => {
    // Symmetry: if a path stops creating claims, the entry must be removed
    // deliberately rather than left as a comforting but dead expectation.
    const creating = new Set(collectCallsites().filter((s) => s.kind === 'create').map((s) => s.file));
    const stale = [...EXPECTED_CREATION_FILES].filter((f) => !creating.has(f));
    assert.deepEqual(stale, [], `listed as creation paths but no longer create a claim:\n${stale.join('\n')}`);
  });

  it('an identifier-argument creation is SEEN (the round-1 blind spot)', () => {
    // watch.ts is the live proof: `const claim: Claim = {…}; saveClaim(claim)`.
    // The regex guard never saw it, and the 1.19.1 fix missed the path entirely.
    const watchSites = collectCallsites().filter((s) => s.file === 'commands/watch.ts');
    assert.ok(watchSites.length > 0, 'watch.ts callsite not resolved — the identifier-tracing path regressed');
    assert.ok(
      watchSites.some((s) => s.kind === 'create' && s.stamped),
      'watch.ts creates a claim via a variable; it must resolve as a stamped creation',
    );
  });

  it('a released/patched claim is an UPDATE, never a creation', () => {
    // Re-stamping on update would move a baseline whose whole point is to be a
    // fixed point. These sites must classify as update so nothing demands a
    // baseline of them.
    const sites = collectCallsites();
    const updates = sites.filter((s) => s.kind === 'update').map((s) => s.file);
    assert.ok(
      updates.includes('commands/mcp-write-coordination.ts'),
      'the `{...oldClaim, status: released}` site must classify as an update',
    );
    assert.ok(
      updates.includes('core/entity-operations.ts'),
      'the patched-claim persist must classify as an update',
    );
  });

  it('the baseline helper omits the key entirely outside a git repo', () => {
    const code = fs.readFileSync(path.join(SRC, 'core/claims.ts'), 'utf-8');
    assert.match(
      code,
      /return base_sha \? \{ base_sha \} : \{\}/,
      'claimBaselineFields must return {} — not { base_sha: undefined }',
    );
  });

  it('saveClaim itself never stamps (it also persists updates)', () => {
    const code = fs.readFileSync(path.join(SRC, 'core/claims.ts'), 'utf-8');
    const body = /export function saveClaim\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    assert.ok(body.length > 0, 'could not locate saveClaim — update this test rather than deleting it');
    assert.doesNotMatch(body, /claimBaselineFields/, 'stamping in saveClaim would re-baseline on every update');
  });
});
