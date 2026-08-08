import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadActiveProject } from './active-project.js';
import { loadConfig } from './config.js';
import { loadCurrentSession, loadSessionById, resolveExplicitSessionId } from './identity.js';
import { MEMORY_DIR } from './io.js';
import { summarizeWorkspaceProjects } from './workspace-projects.js';

export type StoreRole = 'service' | 'repo' | 'workspace' | 'user' | 'unknown';

export interface StoreRef {
  /** Absolute path to the .brainclaw/ directory */
  storePath: string;
  /** Absolute path to the directory containing .brainclaw/ */
  cwd: string;
  /** Distance from the origin cwd: 0 = closest (highest priority) */
  depth: number;
  /** Role declared in config.yaml store_type, or inferred */
  role: StoreRole;
}

export interface ResolveStoreChainOptions {
  /** Override the directory name (default: .brainclaw) */
  dirName?: string;
  /**
   * Absolute path at which to stop walking up.
   * Defaults to os.homedir(). Walk never goes above this directory.
   */
  boundary?: string;
  /**
   * If true, include stores even when their .brainclaw/ directory exists
   * but has no config.yaml (partially initialised stores).
   */
  includePartial?: boolean;
}

/**
 * Walk up the filesystem from `cwd`, collecting every `.brainclaw/` directory
 * found along the way, up to (and including) `boundary`.
 *
 * The returned array is ordered from closest to farthest (index 0 = highest
 * priority). Returns an empty array when no store is found.
 */
export function resolveStoreChain(
  cwd: string = process.cwd(),
  options: ResolveStoreChainOptions = {},
): StoreRef[] {
  const dirName = options.dirName ?? MEMORY_DIR;
  const boundary = options.boundary ?? process.env.BRAINCLAW_STORE_BOUNDARY ?? os.homedir();
  const includePartial = options.includePartial ?? false;

  const results: StoreRef[] = [];
  let current = path.resolve(cwd);
  const boundaryResolved = path.resolve(boundary);
  let depth = 0;

  while (true) {
    const candidate = path.join(current, dirName);
    if (fs.existsSync(candidate)) {
      const configPath = path.join(candidate, 'config.yaml');
      const hasConfig = fs.existsSync(configPath);
      if (hasConfig || includePartial) {
        results.push({
          storePath: candidate,
          cwd: current,
          depth,
          role: inferRole(candidate, configPath, hasConfig),
        });
      }
    }

    // Stop at boundary (inclusive — we already checked it above if applicable)
    if (current === boundaryResolved) break;

    const parent = path.dirname(current);
    // Stop if we've hit the filesystem root (dirname returns same path)
    if (parent === current) break;

    // Stop if we'd go above the boundary
    if (!isAtOrBelow(parent, boundaryResolved)) break;

    current = parent;
    depth++;
  }

  return results;
}

/**
 * Return the single "primary" store for a given cwd — the closest one.
 * Returns undefined when no store exists in the chain.
 */
export function resolvePrimaryStore(
  cwd: string = process.cwd(),
  options: ResolveStoreChainOptions = {},
): StoreRef | undefined {
  return resolveStoreChain(cwd, options)[0];
}

export type StoreTarget = 'local' | 'repo' | 'workspace' | 'user';

/**
 * Resolve the effective cwd for a write operation targeting a specific store level.
 *
 * - `local`     → the closest store (default, current behaviour)
 * - `repo`      → the first store with role='repo' in the chain; falls back to closest
 * - `workspace` → the first store with role='workspace', or the farthest store found
 * - `user`      → the first store with role='user' in the chain; falls back to os.homedir()
 *
 * Returns the original cwd unchanged when no chain exists or when target='local'.
 */
export function resolveTargetStore(
  cwd: string = process.cwd(),
  target: StoreTarget = 'local',
  options: ResolveStoreChainOptions = {},
): string {
  if (target === 'local') return cwd;
  const chain = resolveStoreChain(cwd, options);
  if (chain.length === 0) return cwd;
  if (target === 'repo') {
    const match = chain.find((s) => s.role === 'repo');
    return match?.cwd ?? chain[0]!.cwd;
  }
  if (target === 'workspace') {
    // workspace: prefer declared role, otherwise take farthest
    const match = chain.find((s) => s.role === 'workspace');
    return match?.cwd ?? chain[chain.length - 1]!.cwd;
  }
  // user: prefer declared role, otherwise os.homedir()
  const match = chain.find((s) => s.role === 'user');
  return match?.cwd ?? os.homedir();
}

export interface ResolveEffectiveCwdOptions {
  /** Explicit --cwd flag value (highest priority). */
  explicitCwd?: string;
  /** Base cwd used to resolve session/global active project state. */
  baseCwd?: string;
  /** Explicit MCP connection/session id. Takes precedence over process env. */
  sessionId?: string;
  /** Store chain options passed through to resolveStoreChain. */
  storeChainOptions?: ResolveStoreChainOptions;
}

export type EffectiveCwdSource = 'explicit' | 'env_project' | 'session' | 'cwd_child' | 'global' | 'cwd';

export interface ResolvedEffectiveCwd {
  cwd: string;
  active_source: EffectiveCwdSource;
  resolved_project?: {
    path: string;
    name?: string;
  };
  /**
   * Renseigne quand un record de session TROUVABLE porte un `active_project` que le
   * resolveur n'a PAS retenu (pln#648 SUITE d).
   *
   * POURQUOI CE CHAMP EXISTE. Le defaut d'origine n'etait pas qu'un lecteur se trompait :
   * c'est que DEUX lecteurs pouvaient rendre des verdicts differents sur le MEME record
   * sans que personne ne le voie. `switch` affichait « api » pendant que l'ecriture
   * partait dans « web ». La convergence des lecteurs (1.21.0) supprime le cas reproduit ;
   * ce champ supprime le SILENCE — une divergence residuelle laisse desormais une trace.
   *
   * Il est OBSERVATIONNEL et ne change aucune resolution : le resolveur a deja tranche,
   * et re-trancher ici reintroduirait exactement l'ambiguite qu'on ferme.
   */
  session_divergence?: {
    /** Ce que le record de session designait. */
    session_project_path: string;
    session_project_name?: string;
    /** Le selecteur qui a effectivement gagne. */
    resolved_via: EffectiveCwdSource;
  };
}

/**
 * Single source of truth for the effective working directory.
 *
 * Priority:
 * 1. explicitCwd (--cwd flag)
 * 2. BRAINCLAW_CWD env var → workspace anchor injected by MCP configs
 * 3. BRAINCLAW_PROJECT env var → resolved by name/path from workspace anchor
 * 4. Session-scoped active project (from .current-session under the anchor)
 * 5. cwd_child — the child project the agent is physically inside, under the anchor
 * 5b. cwd_child (no anchor) — same, ceiling = discovered workspace root (F2)
 * 6. Global active-project.json in workspace root
 * 7. Workspace anchor or process.cwd()
 */
export function resolveEffectiveCwd(
  options: ResolveEffectiveCwdOptions = {},
): string {
  return resolveEffectiveCwdInfo(options).cwd;
}

/**
 * Resolve the effective cwd and explain which selector won. Use this for MCP
 * facades that must echo their project scope to avoid silent cross-project reads.
 */
/**
 * Observation collectee PENDANT la resolution, sans lecture disque supplementaire.
 *
 * La sonde de session lit deja le record ; on retient simplement ce qu'elle a vu, y
 * compris quand elle l'a REJETE (identite faible, chemin invalide). C'est precisement ce
 * cas rejete-puis-supplante qui produit la divergence dangereuse — « la session dit api,
 * le pointeur global a impose web ».
 */
interface ResolutionObservation {
  sessionProject?: { path: string; name?: string };
}

function resolveEffectiveCwdInner(
  options: ResolveEffectiveCwdOptions,
  observed: ResolutionObservation,
): ResolvedEffectiveCwd {
  const baseCwd = path.resolve(options.baseCwd ?? process.cwd());

  // 1. Explicit --cwd flag
  if (options.explicitCwd) {
    const cwd = path.resolve(options.explicitCwd);
    return { cwd, active_source: 'explicit', resolved_project: projectInfo(cwd) };
  }

  // 2. BRAINCLAW_CWD env var — set by MCP configs to anchor resolution to the
  //    workspace regardless of the IDE's process.cwd() at launch time. It is a
  //    workspace anchor, not the final answer: session/global active project
  //    state still overrides it.
  let anchorCwd = baseCwd;
  const envCwd = process.env.BRAINCLAW_CWD?.trim();
  const hasEnvWorkspace = !!envCwd && fs.existsSync(path.join(path.resolve(envCwd), MEMORY_DIR, 'config.yaml'));
  if (hasEnvWorkspace) {
    anchorCwd = path.resolve(envCwd);
  }

  // 3. BRAINCLAW_PROJECT env var
  const envProject = process.env.BRAINCLAW_PROJECT;
  if (envProject) {
    const resolved = resolveProjectRef(envProject, anchorCwd, options.storeChainOptions);
    if (resolved) return { cwd: resolved, active_source: 'env_project', resolved_project: projectInfo(resolved) };
  }

  // 4. Session-scoped active project (per-agent, no cross-agent interference).
  //    A session can be persisted under a DIFFERENT store than the anchor we read
  //    from: an agent physically inside a child project gets its session created
  //    AND switched under that child (cwd_child / the switch handler use the
  //    physical cwd), while resolution here anchors at the workspace
  //    (BRAINCLAW_CWD). Sessions are stored per-cwd (sessionsDir(cwd)) with no
  //    chain search, so reading only the anchor makes a successful bclaw_switch
  //    invisible — resolution then silently falls through to cwd_child and pins
  //    the agent to the wrong project (DGX Finding 1, 2026-06-22). Probe the
  //    anchor, the physical baseCwd, and the workspace root for each; the first
  //    session carrying a still-valid active_project wins (anchor first preserves
  //    prior precedence when the session lives where we expect).
  //
  //    pln#648 — the probe set must cover EVERY selector that could have been
  //    effective when the session file was written, because that is what decided
  //    its directory. Two were missing, and both are reachable:
  //      - the cwd_child of step 5: an agent in `apps/api/src` writes its session
  //        under `apps/api`, which is neither baseCwd nor the workspace root;
  //      - the shared global pointer of step 6: a session created while another
  //        agent's `switch --global` was in force lands under THAT project.
  //    The second one was reproduced end-to-end on 2026-08-03 (/c/tmp/bclaw-mono,
  //    v1.20.4): global pointer = web, `bclaw_switch(api)` reported
  //    `{scope: session, name: api}` and `switch --json` read it back as api —
  //    while the session file itself sat in `apps/web/.brainclaw/sessions/`, unseen
  //    here, so every WRITE silently landed in web. Status green, data in the wrong
  //    project: the worst failure mode a shared memory can have. The switch handler
  //    finds the record (it resolves cwd first, landing on web, then reads the
  //    session there); this resolver did not. Same file, two verdicts.
  //    Both new candidates are lazy + memoized and are shared with steps 5/6. When
  //    an earlier probe hits, neither helper runs and the cost is unchanged; after
  //    all three miss, the pointer probe does add one session read before returning
  //    the same `global` answer (review P3-5 — the claim is bounded to the hit path).
  //
  //    STRONG IDENTITY REQUIRED ON THE ADDED CANDIDATES (review P1-1/P1-2, both
  //    scenarios reproduced by the reviewer). `loadCurrentSession` can return a
  //    record this process does not own: the pidless candidate it adopts on
  //    agent+user alone (identity.ts ~145 — agent_id and host_id are NOT compared),
  //    and the legacy `.current-session` fallback (identity.ts ~158), returned with
  //    no agent/user/pid/TTL check whatsoever. Honouring those from a store the
  //    agent never named would let ANOTHER instance's stale intent outrank F1/F2
  //    physical-child isolation — a behavioural expansion, not a bug fix. So the two
  //    NEW candidates accept a session only on strong identity: an explicitly named
  //    session id (argument or env — exact-file lookup), or a record whose pid is
  //    this very process. The three original candidates keep their historical
  //    behaviour untouched: this restriction narrows only what the fix added.
  const explicitSessionId = options.sessionId ?? resolveExplicitSessionId();
  const probedSessionCwds = new Set<string>();
  const probeSessionAt = (
    candidate: string | undefined,
    opts?: { requireStrongIdentity?: boolean },
  ): ResolvedEffectiveCwd | undefined => {
    if (!candidate) return undefined;
    const probeCwd = path.resolve(candidate);
    if (probedSessionCwds.has(probeCwd)) return undefined; // dedup — no double read
    probedSessionCwds.add(probeCwd);
    const session = options.sessionId
      ? loadSessionById(options.sessionId, probeCwd)
      : loadCurrentSession(probeCwd);
    if (!session) return undefined;
    // A named id is an exact-file lookup, so the record IS the one asked for; the
    // pid check covers the unnamed case. Anything else is a weak adoption.
    if (opts?.requireStrongIdentity && !explicitSessionId && session.pid !== process.pid) {
      // Observe avant de rejeter : une session d'un AUTRE processus qui designe un autre
      // projet est exactement le cas ou une ecriture peut partir ailleurs en silence.
      const weak = session.active_project;
      if (weak && !observed.sessionProject) observed.sessionProject = { path: weak.path, name: weak.name };
      return undefined;
    }
    const sp = session.active_project;
    // Retenu AVANT le controle d'adoption : un record trouvable qui designe un projet
    // compte comme observation meme quand il n'est pas retenu.
    if (sp && !observed.sessionProject) observed.sessionProject = { path: sp.path, name: sp.name };
    if (sp && fs.existsSync(path.join(sp.path, MEMORY_DIR, 'config.yaml'))) {
      return { cwd: sp.path, active_source: 'session', resolved_project: { path: sp.path, name: sp.name } };
    }
    return undefined;
  };
  // The step-5 child and the step-6 shared pointer, each resolved AT MOST ONCE
  // and shared with the step that owns it — so adding them to the probe set costs
  // no extra disk work, and a probe can never disagree with the step it mirrors.
  let cwdChildResolved = false;
  let cwdChildValue: string | undefined;
  const cwdChildCandidate = (): string | undefined => {
    if (!cwdChildResolved) {
      cwdChildResolved = true;
      // Anchored (step 5): ceiling = the anchor. Unanchored (step 5b, F2
      // trp_71accb07): ceiling = the discovered workspace root — never homedir.
      const ceiling = hasEnvWorkspace ? anchorCwd : resolveWorkspaceRoot(baseCwd, options.storeChainOptions);
      if (ceiling && baseCwd !== path.resolve(ceiling) && isAtOrBelow(baseCwd, ceiling)) {
        const child = findClosestStoreBelow(baseCwd, ceiling);
        // findClosestStoreBelow walks up EXCLUSIVELY of the ceiling, so a
        // single-project repo can never yield its own root store here.
        if (child && path.resolve(child) !== path.resolve(ceiling)) cwdChildValue = child;
      }
    }
    return cwdChildValue;
  };

  let globalPointerResolved = false;
  let globalPointerValue: { path: string; name?: string } | undefined;
  const globalPointerCandidate = (): { path: string; name?: string } | undefined => {
    if (!globalPointerResolved) {
      globalPointerResolved = true;
      const wsRoot = hasEnvWorkspace ? anchorCwd : resolveWorkspaceRoot(anchorCwd, options.storeChainOptions);
      const active = wsRoot ? loadActiveProject(wsRoot) : undefined;
      if (active && fs.existsSync(path.join(active.path, MEMORY_DIR, 'config.yaml'))) {
        globalPointerValue = { path: active.path, name: active.name };
      }
    }
    return globalPointerValue;
  };

  // `??` short-circuits: the common case (agent at the anchor, session there)
  // costs exactly one session load and never walks for the workspace root. The
  // later probes only run when the cheap ones miss — i.e. the monorepo case where
  // the session was stored under whichever project a PREVIOUS resolution picked
  // (physical child, or the shared pointer — pln#648).
  const sessionHit =
    probeSessionAt(anchorCwd)
    ?? probeSessionAt(baseCwd)
    ?? probeSessionAt(resolveWorkspaceRoot(baseCwd, options.storeChainOptions))
    ?? probeSessionAt(cwdChildCandidate(), { requireStrongIdentity: true })
    ?? probeSessionAt(globalPointerCandidate()?.path, { requireStrongIdentity: true });
  if (sessionHit) return sessionHit;

  // 5. cwd_child — when anchored and the agent is physically inside a child store
  //    STRICTLY under the anchor, resolve THAT child rather than the shared global
  //    pointer or the anchor root. This is the independence rule: physical location
  //    beats a shared/stale global (an agent working in apps/api resolves api, not the
  //    monorepo root, and is not hijacked by another agent's global switch).
  //
  //    GUARD (Codex review): only fire when baseCwd differs from the anchor AND is
  //    at/below it. `findClosestStoreBelow` walks UP to the ceiling but does NOT prove
  //    baseCwd sits below it — without the `isAtOrBelow` guard a baseCwd OUTSIDE the
  //    anchor could match an unrelated `.brainclaw` before hitting the filesystem root.
  //
  //    pln#648: the candidate itself now comes from cwdChildCandidate() so this
  //    step and the session probe above cannot drift apart. Both anchored (5) and
  //    unanchored (5b) cases live in that one helper.
  const cwdChild = cwdChildCandidate();
  if (cwdChild) {
    return { cwd: cwdChild, active_source: 'cwd_child', resolved_project: projectInfo(cwdChild) };
  }

  // 5b. cwd_child (NO anchor) — F2 [trp_71accb07]: even without a BRAINCLAW_CWD
  //     anchor, an agent physically inside a child project must resolve THAT
  //     child rather than a stale/shared global pointer set by another agent.
  //     Ceiling = the discovered workspace root via resolveWorkspaceRoot(baseCwd)
  //     — NOT os.homedir() (that would revive the F6 boundary edge and could let
  //     an unrelated home store influence a monorepo worker). Same containment
  //     guard as the anchored case (isAtOrBelow + a child strictly below).
  //     For a single-project repo this is a strict no-op: findClosestStoreBelow
  //     walks UP to the ceiling EXCLUSIVELY, so it can never return the lone root
  //     store (Codex cadrage non-regression proof, batch 2).
  //     pln#648: both cases are now the single `cwdChildCandidate()` above.

  // 6. Global active-project.json from workspace root
  const globalPointer = globalPointerCandidate();
  if (globalPointer) {
    return {
      cwd: globalPointer.path,
      active_source: 'global',
      resolved_project: { path: globalPointer.path, name: globalPointer.name },
    };
  }

  // 7. Default
  return { cwd: anchorCwd, active_source: 'cwd', resolved_project: projectInfo(anchorCwd) };
}

/**
 * Point d'entree unique de la resolution (pln#648 SUITE d).
 *
 * Enrichit le verdict d'un signal de divergence quand un record de session trouvable
 * designait un AUTRE projet que celui retenu. Le calcul est purement local : la sonde a
 * deja lu le record, aucune lecture disque n'est ajoutee.
 */
export function resolveEffectiveCwdInfo(
  options: ResolveEffectiveCwdOptions = {},
): ResolvedEffectiveCwd {
  const observed: ResolutionObservation = {};
  const result = resolveEffectiveCwdInner(options, observed);

  const seen = observed.sessionProject;
  if (!seen || result.active_source === 'session') return result;
  if (path.resolve(seen.path) === path.resolve(result.cwd)) return result;

  return {
    ...result,
    session_divergence: {
      session_project_path: seen.path,
      session_project_name: seen.name,
      resolved_via: result.active_source,
    },
  };
}

function projectInfo(cwd: string): { path: string; name?: string } {
  try {
    const config = loadConfig(cwd);
    return { path: cwd, name: config.project_name };
  } catch {
    return { path: cwd };
  }
}

/**
 * Find the workspace root (farthest store in the chain, or the one with
 * role=workspace). Returns undefined when no store exists.
 */
export function resolveWorkspaceRoot(
  cwd: string = process.cwd(),
  options: ResolveStoreChainOptions = {},
): string | undefined {
  const chain = resolveStoreChain(cwd, options);
  if (chain.length === 0) return undefined;
  const ws = chain.find((s) => s.role === 'workspace');
  return ws?.cwd ?? chain[chain.length - 1]!.cwd;
}

/**
 * Resolve a project reference (name or relative path) to an absolute path.
 * Returns undefined when the reference cannot be resolved to a valid brainclaw project.
 */
export function resolveProjectRef(
  ref: string,
  cwd: string = process.cwd(),
  storeChainOptions?: ResolveStoreChainOptions,
): string | undefined {
  const envWorkspace = process.env.BRAINCLAW_CWD?.trim();
  const workspaceAnchor = envWorkspace && fs.existsSync(path.join(path.resolve(envWorkspace), MEMORY_DIR, 'config.yaml'))
    ? path.resolve(envWorkspace)
    : undefined;

  // Walk UP from real cwd to find the outermost .brainclaw/ — this avoids
  // circular resolution when an active project narrows the workspace view.
  const wsRoot = workspaceAnchor
    ?? findOutermostBrainclawRoot(cwd)
    ?? resolveWorkspaceRoot(cwd, storeChainOptions);
  if (!wsRoot) return undefined;

  // The trust boundary for raw path refs is the provided cwd.  Callers in
  // MCP context set cwd to the workspace root, so child projects resolve
  // naturally.  Walking further up (to a user-level store at home) would
  // allow path-injection to sibling or home stores — that is the vulnerability
  // we are closing.  Name-based lookup below is unrestricted since it matches
  // by project_name / project_id, not by arbitrary path.
  const trustBoundary = path.resolve(cwd);

  // Try as absolute path — only allowed if within the cwd boundary.
  if (path.isAbsolute(ref)) {
    if (!isAtOrBelow(ref, trustBoundary)) return undefined;
    return fs.existsSync(path.join(ref, MEMORY_DIR, 'config.yaml')) ? ref : undefined;
  }

  // Try as relative path resolved from the cwd boundary.
  // Guards against ../ traversal (e.g. "../sibling-project").
  const asPath = path.resolve(trustBoundary, ref);
  if (!isAtOrBelow(asPath, trustBoundary)) return undefined;
  if (fs.existsSync(path.join(asPath, MEMORY_DIR, 'config.yaml'))) {
    return asPath;
  }

  // The workspace root itself is a legal target — it is the "umbrella" project
  // of a monorepo. The chain scan below deliberately skips wsRoot (so a child
  // can never be shadowed by the root), but an agent must still be able to
  // target the root by its own project_name/project_id. Without this, an agent
  // working inside a child cannot switch UP to the monorepo root: bclaw_switch
  // (and project="<root-name>" routing) failed with "Cannot resolve project"
  // (DGX dogfood 2026-06-22, Finding 1). Matching by name/id — not by arbitrary
  // path — preserves the path-injection trust boundary enforced above.
  try {
    const rootConfig = loadConfig(wsRoot);
    if (rootConfig.project_name === ref || rootConfig.project_id === ref) return wsRoot;
  } catch {
    // unreadable workspace-root config — fall through to the child scan
  }

  // Try by project name or project ID: scan child stores
  const chain = resolveStoreChain(wsRoot, storeChainOptions);
  for (const store of chain) {
    if (store.cwd === wsRoot) continue;
    try {
      const config = loadConfig(store.cwd);
      if (config.project_name === ref || config.project_id === ref) return store.cwd;
    } catch {
      // skip unreadable configs
    }
  }

  // Try discovering child projects by scanning filesystem (deep scan for monorepos)
  try {
    const wsConfig = loadConfig(wsRoot);
    const summary = summarizeWorkspaceProjects(wsRoot, wsConfig);
    for (const project of summary.discovered_projects) {
      const projectPath = path.resolve(wsRoot, project.path);
      if (
        project.project_name === ref
        || project.project_id === ref
        || path.basename(project.path) === ref
      ) {
        if (fs.existsSync(path.join(projectPath, MEMORY_DIR, 'config.yaml'))) {
          return projectPath;
        }
      }
    }
  } catch {
    // fall through
  }

  return undefined;
}

/**
 * Walk UP from a directory and return the outermost .brainclaw/ root found.
 * This bypasses resolveEffectiveCwd / active project to find the true workspace root.
 */
export function findOutermostBrainclawRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  const home = os.homedir();
  let outermost: string | undefined;

  while (dir !== root && dir !== home) {
    if (fs.existsSync(path.join(dir, MEMORY_DIR, 'config.yaml'))) {
      outermost = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return outermost;
}

/**
 * Resolve the most specific child store that should answer a context request.
 *
 * This keeps the current cwd by default, but when `target` clearly points inside
 * a nested Brainclaw project (for example from a workspace root in folder mode),
 * it returns that child store cwd instead.
 */
export function resolveContextStoreCwd(
  cwd: string = process.cwd(),
  target?: string,
): string {
  const trimmedTarget = target?.trim();
  if (!trimmedTarget) {
    return cwd;
  }

  const primary = resolvePrimaryStore(cwd);
  if (!primary) {
    return cwd;
  }

  const absoluteTarget = resolveAbsoluteTargetPath(cwd, trimmedTarget);
  if (!absoluteTarget) {
    return cwd;
  }

  // ── Fast path: walk from target upward to cwd looking for a child store ──
  // This works regardless of project_mode or strategy configuration.
  const childStore = findClosestStoreBelow(absoluteTarget, primary.cwd);
  if (childStore) {
    return childStore;
  }

  // ── Fallback: use workspace project discovery (folder mode, registry, etc.) ──
  let config;
  try {
    config = loadConfig(primary.cwd);
  } catch {
    return cwd;
  }

  const summary = summarizeWorkspaceProjects(primary.cwd, config);
  if (summary.discovered_projects.length === 0) {
    return cwd;
  }

  const candidates = summary.discovered_projects
    .map((project) => path.resolve(primary.cwd, project.path))
    .filter((candidatePath) => candidatePath !== primary.cwd)
    .filter((candidatePath) => fs.existsSync(path.join(candidatePath, MEMORY_DIR)))
    .sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    if (isAtOrBelow(absoluteTarget, candidate)) {
      return candidate;
    }
  }

  return cwd;
}

/**
 * Walk from `target` upward toward `ceiling` (exclusive), returning the first
 * directory that contains a `.brainclaw/config.yaml`.  Returns undefined when
 * no child store is found between target and ceiling.
 *
 * This deliberately bypasses workspace project discovery so that child stores
 * are resolved even when the parent config is set to auto/manual mode.
 */
function findClosestStoreBelow(target: string, ceiling: string): string | undefined {
  const resolvedCeiling = path.resolve(ceiling);

  // If target is a file, start from its parent directory
  let current: string;
  try {
    current = fs.statSync(target).isDirectory() ? path.resolve(target) : path.resolve(path.dirname(target));
  } catch {
    // Target doesn't exist on disk — try its parent as a directory
    current = path.resolve(path.dirname(target));
  }

  while (current !== resolvedCeiling) {
    const configPath = path.join(current, MEMORY_DIR, 'config.yaml');
    if (fs.existsSync(configPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }

  return undefined;
}

/**
 * Return true if `dir` is at or below `ancestor` in the filesystem hierarchy.
 */
function isAtOrBelow(dir: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, dir);
  // '..' prefix → dir is above ancestor. An absolute result means a different
  // Windows drive (path.relative returns the absolute `to` path then), which is
  // also outside the boundary — without this check `D:\evil` would pass.
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveAbsoluteTargetPath(cwd: string, target: string): string | undefined {
  if (path.isAbsolute(target)) {
    return path.resolve(target);
  }

  const joined = path.resolve(cwd, target);
  if (fs.existsSync(joined)) {
    return joined;
  }

  if (target.includes('/') || target.includes('\\') || target.startsWith('.')) {
    return joined;
  }

  return undefined;
}

/**
 * Infer the store role from config.yaml store_type field, or fall back to
 * heuristics (presence of .git sibling = repo, no parent store = workspace).
 */
function inferRole(
  storePath: string,
  configPath: string,
  hasConfig: boolean,
): StoreRole {
  if (hasConfig) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const match = raw.match(/store_type:\s*(\S+)/);
      if (match) {
        const val = match[1].trim();
        if (val === 'workspace' || val === 'repo' || val === 'service' || val === 'user') {
          return val as StoreRole;
        }
      }
    } catch {
      // non-fatal — fall through to heuristics
    }
  }
  // Heuristic: if a .git directory lives alongside .brainclaw/, treat as repo
  const siblingGit = path.join(path.dirname(storePath), '.git');
  if (fs.existsSync(siblingGit)) return 'repo';
  return 'unknown';
}
