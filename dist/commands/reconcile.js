import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { buildMachineProfile, saveMachineProfile } from '../core/machine-profile.js';
import { buildAgentInventory, saveAgentInventory } from '../core/agent-inventory.js';
import { applyBootstrapImport, runBootstrapProfile } from '../core/bootstrap.js';
import { loadConfig } from '../core/config.js';
import { memoryExists } from '../core/io.js';
import { summarizeWorkspaceProjects } from '../core/workspace-projects.js';
export async function runReconcile(options = {}) {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    if (!memoryExists(cwd)) {
        console.error('Error: .brainclaw/ not found in the current directory. Run `brainclaw init` first.');
        process.exit(1);
    }
    const rootConfig = loadConfig(cwd);
    const workspaceSummary = summarizeWorkspaceProjects(cwd, rootConfig);
    const storeTargets = [
        cwd,
        ...workspaceSummary.uses_folder_resolution
            ? workspaceSummary.discovered_projects
                .filter((project) => project.source !== 'config')
                .map((project) => project.path)
            : [],
    ];
    const uniqueTargets = [...new Set(storeTargets.map((store) => path.resolve(store)))];
    if (options.json && options.dryRun) {
        console.log(JSON.stringify({
            cwd,
            mode: 'dry_run',
            workspace_summary: workspaceSummary,
            planned_actions: {
                machine_profile_refresh: !options.skipMachineProfile,
                agent_inventory_refresh: !options.skipAgentInventory,
                bootstrap_refresh: uniqueTargets.map((store) => ({
                    cwd: store,
                    relative_path: path.relative(cwd, store) || '.',
                    apply_bootstrap: Boolean(options.applyBootstrap),
                })),
            },
        }, null, 2));
        return;
    }
    if (options.applyBootstrap) {
        await confirmBootstrapApply(options.yes);
    }
    const machineProfilePath = !options.skipMachineProfile
        ? saveMachineProfile(buildMachineProfile())
        : null;
    const agentInventoryPath = !options.skipAgentInventory
        ? saveAgentInventory(buildAgentInventory())
        : null;
    const stores = [];
    for (const store of uniqueTargets) {
        const config = loadConfig(store);
        if (options.applyBootstrap) {
            const result = applyBootstrapImport({ cwd: store, refresh: true });
            stores.push({
                cwd: store,
                relative_path: path.relative(cwd, store) || '.',
                project_name: config.project_name,
                project_mode: config.project_mode,
                project_strategy: config.projects.strategy,
                bootstrap_refreshed: true,
                bootstrap_applied: true,
                workspace_kind: result.proposal.workspace_kind,
                onboarding_mode: result.proposal.onboarding_mode,
                confidence: result.proposal.confidence,
                suggestion_count: result.proposal.suggestion_count,
                created_count: result.createdCount,
                skipped_count: result.skippedCount,
            });
            continue;
        }
        const result = runBootstrapProfile({ cwd: store, refresh: true });
        stores.push({
            cwd: store,
            relative_path: path.relative(cwd, store) || '.',
            project_name: config.project_name,
            project_mode: config.project_mode,
            project_strategy: config.projects.strategy,
            bootstrap_refreshed: true,
            bootstrap_applied: false,
            workspace_kind: result.profile.workspace_kind,
            onboarding_mode: result.profile.onboarding_mode,
            confidence: result.profile.confidence,
            suggestion_count: result.importPlan.suggestion_count,
        });
    }
    if (options.json) {
        console.log(JSON.stringify({
            cwd,
            mode: options.applyBootstrap ? 'apply' : 'refresh',
            workspace_summary: workspaceSummary,
            machine_profile_refreshed: !options.skipMachineProfile,
            machine_profile_path: machineProfilePath,
            agent_inventory_refreshed: !options.skipAgentInventory,
            agent_inventory_path: agentInventoryPath,
            stores,
        }, null, 2));
        return;
    }
    if (!options.skipMachineProfile) {
        console.log(`✔ Machine profile refreshed: ${machineProfilePath}`);
    }
    if (!options.skipAgentInventory) {
        console.log(`✔ Agent inventory refreshed: ${agentInventoryPath}`);
    }
    console.log('');
    console.log(`Reconciled ${stores.length} store(s):`);
    for (const store of stores) {
        const suffix = store.bootstrap_applied
            ? `${store.created_count ?? 0} created, ${store.skipped_count ?? 0} skipped`
            : `${store.suggestion_count ?? 0} bootstrap suggestion(s) available`;
        console.log(`  - ${store.relative_path} (${store.project_name}) — ${store.onboarding_mode ?? 'unknown'}, confidence=${store.confidence ?? 'unknown'}, ${suffix}`);
    }
}
async function confirmBootstrapApply(yes) {
    if (yes) {
        return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error('Error: bootstrap apply across multiple stores requires --yes in non-interactive mode.');
        process.exit(1);
    }
    const rl = readline.createInterface({ input, output });
    try {
        const answer = await rl.question('Apply bootstrap suggestions across all selected stores? [y/N] ');
        if (answer.trim().toLowerCase() !== 'y') {
            console.error('Cancelled.');
            process.exit(1);
        }
    }
    finally {
        rl.close();
    }
}
//# sourceMappingURL=reconcile.js.map