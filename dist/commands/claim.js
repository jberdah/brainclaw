import { buildOperationalIdentity } from '../core/identity.js';
import { memoryExists } from '../core/io.js';
import { mutate } from '../core/mutation-pipeline.js';
import { saveClaim, generateClaimId, listClaims } from '../core/claims.js';
import { rebuildProjectMd } from '../core/markdown.js';
import { loadState, saveState } from '../core/state.js';
import { nowISO } from '../core/ids.js';
import { requireMinimumTrustLevel, requireRegisteredAgentIdentity, resolveCurrentModel } from '../core/agent-registry.js';
import { validateCliTtl } from '../core/input-validation.js';
import { resolveTargetStore } from '../core/store-resolution.js';
function parseTtl(ttl) {
    const match = /^(\d+)([mhd])$/.exec(ttl.trim().toLowerCase());
    if (!match)
        return new Date(Date.now() + 8 * 3_600_000).toISOString();
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const ms = unit === 'm' ? value * 60_000 : unit === 'h' ? value * 3_600_000 : value * 86_400_000;
    return new Date(Date.now() + ms).toISOString();
}
export function runClaim(description, options) {
    const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
    options = { ...options, cwd };
    if (!memoryExists(options.cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    if (options.ttl)
        validateCliTtl(options.ttl);
    let actor;
    try {
        const registered = requireRegisteredAgentIdentity({
            agentName: options.agent,
            agentId: options.agentId,
            cwd: options.cwd,
            allowCurrent: true,
            allowEnv: true,
        });
        requireMinimumTrustLevel(registered, 'contributor');
        actor = buildOperationalIdentity(registered.agent_name, options.cwd, { agentId: registered.agent_id });
    }
    catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
    // Check for overlapping active claims on the same scope
    const existing = listClaims(options.cwd).filter(c => c.status === 'active' && c.scope === options.scope);
    if (existing.length > 0) {
        console.warn(`⚠ Active claim(s) already exist for scope "${options.scope}":`);
        for (const c of existing) {
            console.warn(`  [${c.id}] by ${c.agent}: ${c.description}`);
        }
        console.warn('  Proceeding anyway (advisory only).');
    }
    const state = loadState(options.cwd);
    const plan = options.plan ? state.plan_items.find((item) => item.id === options.plan) : undefined;
    if (options.plan && !plan) {
        console.error(`Error: Plan item '${options.plan}' not found.`);
        process.exit(1);
    }
    const id = generateClaimId();
    const claim = {
        id,
        agent: actor.agent,
        agent_id: actor.agent_id,
        project_id: actor.project_id,
        host_id: actor.host_id,
        session_id: actor.session_id,
        scope: options.scope,
        description,
        created_at: nowISO(),
        project: options.project ?? plan?.project,
        plan_id: options.plan,
        status: 'active',
        expires_at: options.ttl ? parseTtl(options.ttl) : undefined,
        model: resolveCurrentModel(options.cwd),
    };
    mutate({ cwd: options.cwd }, () => {
        if (plan) {
            if (!plan.assignee) {
                plan.assignee = actor.agent;
            }
            if (plan.status === 'todo') {
                plan.status = 'in_progress';
            }
            plan.updated_at = nowISO();
            saveState(state, options.cwd);
        }
        saveClaim(claim, options.cwd);
        rebuildProjectMd(plan ? state : loadState(options.cwd), options.cwd);
    });
    const planInfo = claim.plan_id ? ` [plan ${claim.plan_id}]` : '';
    const ttlInfo = claim.expires_at ? ` (expires ${claim.expires_at.slice(0, 16).replace('T', ' ')})` : '';
    const storeLabel = options.store && options.store !== 'local' ? ` [store:${options.store}]` : '';
    console.log(`✔ Claim created: [${id}] ${actor.agent} → ${options.scope}: ${description}${planInfo}${ttlInfo}${storeLabel}`);
}
//# sourceMappingURL=claim.js.map