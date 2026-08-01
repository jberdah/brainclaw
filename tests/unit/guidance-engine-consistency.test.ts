/**
 * pln#638 volet 2c — guidance ↔ engine consistency.
 *
 * THE DEFECT THIS FILE EXISTS FOR: brainclaw GENERATES guidance (instruction
 * files, exported CLAUDE.md/AGENTS.md, hook scripts) and nothing ever checked
 * that the generated text still matches the engine it describes. Three instances
 * have shipped:
 *
 *   1. trp_7fc3e3c4 — generated guidance contradicting pln#520 went out to every
 *      project.
 *   2. `claude-pre-tool.sh` — a generated PreToolUse hook reading
 *      `CLAUDE_TOOL_NAME` from env, a protocol Claude Code does not use. Dead for
 *      an unknown number of releases.
 *   3. cst_38effd52 — that same hook wrote its advisory to **stderr with exit 0**,
 *      which Claude Code does not surface to the model at all. So even a hook
 *      fixed for (2) would have emitted into the void. Found by reading the host
 *      contract, five minutes of work that no test was doing.
 *
 * All three are the same class: prose or generated code asserting a behaviour
 * nobody verifies. The tests below turn that class into CI failures.
 *
 * DESIGN RULE (review finding F1, github-copilot): every claim checked here is
 * DERIVED from the code that owns it, never hand-enumerated. A hand-maintained
 * list of "things to check" would itself be an unverified guidance surface — it
 * would reproduce the defect one level up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS } from '../../src/commands/mcp.js';
import { PUBLISHED_TOOLS } from '../../src/commands/mcp-catalog.js';
import { DEFAULT_CAPABILITY_PROFILES } from '../../src/core/agent-capability.js';
import { renderLiveSection, renderStableSection } from '../../src/core/instruction-templates.js';

/**
 * Walk up to the repo root. A fixed relative depth breaks depending on whether
 * the test runs from `tests/unit/` or the compiled `dist-test/tests/unit/`, and
 * this suite reads SOURCE files (it inspects generated-guidance text, which only
 * exists in `src/`).
 */
function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repo root not found walking up from ${import.meta.dirname}`);
}

const REPO_ROOT = findRepoRoot();
const SRC = path.join(REPO_ROOT, 'src');

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8');
}

/**
 * Strip comments before scanning.
 *
 * PRECISION MATTERS MORE THAN REACH HERE. The first version of this suite
 * flagged `bclaw_get_context` in agent-files.ts — which appears only inside a
 * comment explaining that the code deliberately FILTERS that retired name out.
 * The code was correct; the test was crying wolf, and a consistency test that
 * cries wolf gets muted, which is worse than not having it. Only text that can
 * reach a generated artifact counts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Line comments only when `//` starts the trimmed line or follows whitespace,
    // so a `https://` inside a string literal survives.
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

/** Every tool name the catalog actually exposes — the source of truth. */
const CATALOG_TOOL_NAMES = new Set((ALL_TOOLS as ReadonlyArray<{ name: string }>).map((t) => t.name));

/**
 * Modules that GENERATE agent-facing guidance. Derived by asking the filesystem
 * which modules render instruction/hook text, not by maintaining a list: a new
 * generator lands under one of these names and is picked up automatically.
 */
function guidanceGeneratingSources(): string[] {
  const candidates = [
    'core/instruction-templates.ts',
    'core/agent-files.ts',
    'core/protocol-skills.ts',
    'commands/install-hooks.ts',
    'commands/hooks.ts',
  ];
  return candidates.filter((rel) => fs.existsSync(path.join(SRC, rel)));
}

describe('guidance ↔ engine — every tool named in generated guidance exists', () => {
  it('covers at least the known generators (so this test cannot silently check nothing)', () => {
    const sources = guidanceGeneratingSources();
    assert.ok(sources.length >= 4, `expected the guidance generators to be present, got ${sources.join(', ')}`);
  });

  it('names no tool that is absent from the catalog', () => {
    // The pln#634 contract test applied to PROSE surfaces: a generated
    // instruction file telling an agent to call a tool that does not exist is
    // the same failure as a next_action with a bad shape (trp_dfb58908).
    const offenders: string[] = [];
    for (const rel of guidanceGeneratingSources()) {
      const text = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf-8'));
      // Full tool tokens only. A trailing `_` (e.g. `bclaw_code_` used as a
      // prefix in prose) is a fragment, not a call, and is skipped.
      for (const match of text.matchAll(/\bbclaw_[a-z_]+\b/g)) {
        const name = match[0];
        if (name.endsWith('_')) continue;
        if (!CATALOG_TOOL_NAMES.has(name)) offenders.push(`${rel}: ${name}`);
      }
    }
    assert.deepEqual(offenders, [], `generated guidance names non-existent tool(s):\n${offenders.join('\n')}`);
  });
});

describe('guidance ↔ engine — generated hooks respect their host contract', () => {
  /**
   * cst_38effd52 — Claude Code PreToolUse, per code.claude.com/docs/en/hooks:
   *   exit 0        → stdout parsed for JSON; stderr NOT shown to the model
   *   exit 2        → stderr IS fed to the model, but the tool is BLOCKED
   *   other non-zero → non-blocking; stderr goes to the USER, not the model
   *
   * So an advisory hook (must not block) can only reach the model through
   * `hookSpecificOutput.additionalContext` on stdout with exit 0. A hook that
   * writes its advisory to stderr is mute — which is exactly what shipped.
   */
  // stripComments on EVERY assertion below, not just some: the first version of
  // this suite failed on its own explanatory comments (which necessarily name
  // `CLAUDE_TOOL_NAME` and `exit 2` to document why they are wrong). A test that
  // fails on the prose describing its own invariant is unusable.
  const preToolUseGenerators = ['commands/install-hooks.ts', 'commands/hooks.ts']
    .filter((rel) => fs.existsSync(path.join(SRC, rel)))
    .map((rel) => ({ rel, text: stripComments(fs.readFileSync(path.join(SRC, rel), 'utf-8')) }))
    .filter(({ text }) => /PreToolUse|pre-tool/i.test(text));

  it('finds the PreToolUse generator (guard against the test going blind)', () => {
    assert.ok(
      preToolUseGenerators.length >= 1,
      'no PreToolUse hook generator found — if the generator moved, update this test rather than deleting it',
    );
  });

  for (const { rel, text } of preToolUseGenerators) {
    it(`${rel}: a generated PreToolUse hook reads the tool name from stdin, not from env`, () => {
      // Claude Code delivers a JSON payload on stdin. Reading CLAUDE_TOOL_NAME
      // from the environment yields undefined, so the hook exits before doing
      // anything — defect (2) above.
      assert.doesNotMatch(
        text,
        /CLAUDE_TOOL_NAME/,
        'the PreToolUse contract passes a JSON payload on STDIN; CLAUDE_TOOL_NAME is not a Claude Code env var, '
        + 'so a hook reading it is dead on arrival (cst_38effd52)',
      );
    });

    it(`${rel}: a generated PreToolUse hook does not try to advise the model via stderr`, () => {
      // Defect (3): stderr at exit 0 never reaches the model. If the generated
      // script writes to stderr, it must be for the USER (a diagnostic), and it
      // must ALSO carry an additionalContext payload for the model — otherwise
      // the advisory is silent.
      const writesStderr = /stderr\.write|>&2|console\.error/.test(text);
      const usesAdditionalContext = /additionalContext/.test(text);
      if (writesStderr) {
        assert.ok(
          usesAdditionalContext,
          'this generator writes to stderr; at exit 0 Claude Code does NOT surface stderr to the model, so the '
          + 'advisory is invisible. Emit hookSpecificOutput.additionalContext on stdout instead (cst_38effd52).',
        );
      }
    });

    it(`${rel}: a generated PreToolUse hook never blocks (advisory-first)`, () => {
      // trp_5f342186 — a hook cascade destroyed work. Only exit 2 blocks a
      // PreToolUse call, so exit 2 must not appear, and any permissionDecision
      // must be "allow".
      assert.doesNotMatch(
        text,
        /exit\s*\(?\s*2\s*\)?\s*[;`'"]|process\.exit\(2\)/,
        'exit code 2 BLOCKS the tool call. v1 guidance hooks are advisory-only (trp_5f342186).',
      );
      for (const match of text.matchAll(/permissionDecision["'\s:]+([a-z]+)/g)) {
        assert.equal(match[1], 'allow', 'an advisory hook must always decide "allow"');
      }
    });
  }
});

/**
 * RENDER the guidance and scan the OUTPUT — the strongest form of this check.
 *
 * Scanning source files cannot distinguish a template literal that reaches an
 * agent from a comment explaining an exclusion, or from a TypeScript `const`
 * whose NAME merely looks like an env var. Three false positives came out of
 * exactly that while this suite was being built. Rendering removes the
 * ambiguity: whatever the renderer returns is, by definition, what an agent
 * reads.
 */
/**
 * The state fixture, in the shape the renderer ACTUALLY reads
 * (`instruction-templates.ts` lines 342-471: active_constraints, known_traps,
 * plan_items, open_handoffs, recent_decisions).
 *
 * THIS WAS WRONG WHEN THE SUITE SHIPPED, and it silently gutted the guard. The
 * fixture used plausible-but-nonexistent names (traps, decisions, constraints,
 * handoffs), every renderer that touched one threw, and the `try/catch` below
 * swallowed it. Measured after the fix: 7 of 19 stable surfaces and 0 of 16 live
 * surfaces were being checked — the highest-leverage item in the guidance
 * backlog was covering ~18% of its target, and the "renders at least one
 * surface" guard passed happily on the 7 survivors.
 *
 * A guard that silently checks less than it claims is the very failure class this
 * suite exists to prevent, one level up. Hence: no swallowing, and a coverage
 * assertion with real numbers.
 */
const RENDER_STATE_FIXTURE = {
  active_constraints: [],
  known_traps: [],
  plan_items: [],
  open_handoffs: [],
  recent_decisions: [],
};

interface RenderedSurfaces {
  surfaces: Array<{ label: string; text: string }>;
  /** Render failures, which are now FAILURES rather than silent skips. */
  errors: string[];
  profileCount: number;
  liveCount: number;
}

function renderedGuidanceSurfacesDetailed(): RenderedSurfaces {
  const surfaces: Array<{ label: string; text: string }> = [];
  const errors: string[] = [];
  const profiles = Object.values(DEFAULT_CAPABILITY_PROFILES);
  let liveCount = 0;
  for (const profile of profiles) {
    const input = {
      profile,
      state: RENDER_STATE_FIXTURE,
      projectName: 'consistency-fixture',
      brainclawVersion: '0.0.0-test',
      resolvedInstructions: [],
    } as unknown as Parameters<typeof renderStableSection>[0];
    try {
      surfaces.push({ label: `stable:${profile.name}`, text: renderStableSection(input).content });
    } catch (err) {
      errors.push(`stable:${profile.name} — ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const live = renderLiveSection(input);
      // undefined is legitimate: not every profile has a live-companion tier.
      if (live) { surfaces.push({ label: `live:${profile.name}`, text: live.content }); liveCount += 1; }
    } catch (err) {
      errors.push(`live:${profile.name} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { surfaces, errors, profileCount: profiles.length, liveCount };
}

function renderedGuidanceSurfaces(): Array<{ label: string; text: string }> {
  return renderedGuidanceSurfacesDetailed().surfaces;
}

describe('guidance ↔ engine — RENDERED guidance, not source text', () => {
  it('renders EVERY profile without swallowing a single failure', () => {
    // The guard this suite needed and did not have. "At least one surface" was
    // satisfiable by 7 of 35 possible renders.
    const { errors } = renderedGuidanceSurfacesDetailed();
    assert.deepEqual(errors, [], `a guidance surface failed to render (the fixture or the renderer drifted):\n${errors.join('\n')}`);
  });

  it('checks a stable surface for every profile, and the live companions too', () => {
    const { surfaces, profileCount, liveCount } = renderedGuidanceSurfacesDetailed();
    const stable = surfaces.filter((s) => s.label.startsWith('stable:')).length;
    assert.equal(stable, profileCount, 'every capability profile must contribute a stable surface');
    assert.ok(liveCount > 0, 'no live companion surface was checked — 2a/2b guidance would be unguarded');
    assert.equal(surfaces.length, stable + liveCount);
  });

  it('no RENDERED surface names a tool absent from the published catalog', () => {
    // PUBLISHED_TOOLS, not ALL_TOOLS: the v1.0-removed names are hidden from
    // every tools/list, so an agent literally cannot discover them. Telling an
    // agent to call one is the trp_7fc3e3c4 class.
    const published = new Set((PUBLISHED_TOOLS as ReadonlyArray<{ name: string }>).map((t) => t.name));
    const offenders: string[] = [];
    for (const { label, text } of renderedGuidanceSurfaces()) {
      for (const match of text.matchAll(/\bbclaw_[a-z_]+\b/g)) {
        const name = match[0];
        if (name.endsWith('_')) continue;
        if (!published.has(name)) offenders.push(`${label}: ${name}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `RENDERED guidance names tool(s) an agent cannot discover:\n${offenders.join('\n')}`,
    );
  });
});

describe('guidance ↔ engine — load-bearing claims are DERIVED, not enumerated', () => {
  /**
   * Review finding F1: a hand-written list of claims to verify is itself an
   * unverified guidance surface. So the kill-switch names are read out of the
   * code that READS the env var, and the guidance is checked against that.
   */
  function killSwitchNamesFromCode(): Set<string> {
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const text = fs.readFileSync(full, 'utf-8');
        for (const m of text.matchAll(/process\.env\.(BRAINCLAW_[A-Z0-9_]+)/g)) names.add(m[1]);
      }
    };
    walk(SRC);
    return names;
  }

  it('derives a non-trivial set of BRAINCLAW_* switches from the code that reads them', () => {
    const derived = killSwitchNamesFromCode();
    assert.ok(derived.size >= 5, `expected several env switches, derived ${derived.size}`);
    // Sanity: the switch this session shipped must be in the derived set,
    // proving the derivation actually reads the real call sites.
    assert.ok(
      derived.has('BRAINCLAW_GUIDANCE_TELEMETRY'),
      'derivation missed a switch that demonstrably exists — the regex or the walk is wrong',
    );
  });

  it('every BRAINCLAW_* switch named in RENDERED guidance is one the code actually reads', () => {
    // The trp_7fc3e3c4 class: guidance describing a behaviour the engine does
    // not have. A documented switch nobody reads is exactly that.
    //
    // Scanned on RENDERED output for the same reason as the tool-name check:
    // source text contains TypeScript consts (BRAINCLAW_SECTION_START, …) whose
    // names look like env vars but never reach an agent. That was this test's
    // bug, not the code's — found while building the suite.
    const derived = killSwitchNamesFromCode();
    const offenders: string[] = [];
    for (const { label, text } of renderedGuidanceSurfaces()) {
      for (const m of text.matchAll(/\b(BRAINCLAW_[A-Z0-9_]+)\b/g)) {
        if (!derived.has(m[1])) offenders.push(`${label}: ${m[1]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `RENDERED guidance documents env switch(es) no code reads:\n${offenders.join('\n')}`,
    );
  });
});

describe('guidance ↔ engine — generated surfaces do not claim a freshness they lack', () => {
  it('the live header does not assert "auto-refreshed" without naming the real triggers', () => {
    // Regeneration is EXPLICIT (session-end / handoff / export --write). A tier
    // that never fires those reads a file claiming to be fresh while being
    // arbitrarily stale — a claim that is false for half the tiers is worse than
    // no claim (pln#638 volet 2a).
    const text = stripComments(read('src/core/instruction-templates.ts'));
    const headerMatch = text.match(/function renderLiveHeader[\s\S]{0,900}?\n\}/);
    assert.ok(headerMatch, 'renderLiveHeader not found — if it moved, update this test');
    const header = headerMatch[0];
    if (/auto-refreshed/i.test(header)) {
      assert.match(
        header,
        /session-end|handoff|export/i,
        'the live header claims "auto-refreshed" but regeneration is explicit — name the actual triggers '
        + 'so an agent on a tier that never fires them knows the file may be stale (pln#638 volet 2a)',
      );
    }
  });
});
