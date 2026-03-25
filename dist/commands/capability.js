import { loadState, persistState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { memoryExists } from '../core/io.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { loadConfig } from '../core/config.js';
import { scanText } from '../core/security.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore } from '../core/store-resolution.js';
export function runCapability(subcommand, args, options = {}) {
    const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
    if (!memoryExists(cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    if (subcommand === 'list') {
        runCapabilityList(cwd);
    }
    else if (subcommand === 'add') {
        const name = args[0];
        const description = args[1];
        if (!name || !description) {
            console.error('Error: capability add requires <name> <description>');
            process.exit(1);
        }
        runCapabilityAdd(name, description, options, cwd);
    }
    else if (subcommand === 'describe') {
        const capId = args[0];
        if (!capId) {
            console.error('Error: capability describe requires <id>');
            process.exit(1);
        }
        runCapabilityDescribe(capId, cwd);
    }
    else {
        console.error(`Unknown capability subcommand: ${subcommand}`);
        process.exit(1);
    }
}
function runCapabilityList(cwd) {
    const state = loadState(cwd);
    const capabilities = state.active_constraints
        .filter((c) => c.tags.includes('capability'))
        .map((c) => ({ id: c.id, name: c.text.split('\n')[0], tags: c.tags }));
    if (capabilities.length === 0) {
        console.log('No capabilities registered yet.');
        return;
    }
    console.log(`\n${capabilities.length} capability(ies):\n`);
    capabilities.forEach((cap) => {
        console.log(`  [${cap.id}] ${cap.name}`);
        if (cap.tags.length > 1) {
            console.log(`      tags: ${cap.tags.filter((t) => t !== 'capability').join(', ')}`);
        }
    });
    console.log('');
}
function runCapabilityAdd(name, description, options, cwd) {
    validateCliInput(name + ' ' + description, options.tag);
    const config = loadConfig(cwd);
    const warnings = scanText(name + ': ' + description, config);
    for (const w of warnings) {
        console.warn(`⚠ ${w.message}`);
        if (w.level === 'block') {
            console.error('Blocked: strict redaction is enabled. Entry not added.');
            process.exit(1);
        }
    }
    const state = loadState(cwd);
    const { id, short_label } = generateIdWithLabel('recent_decisions');
    const entry = {
        id,
        short_label,
        text: name,
        created_at: nowISO(),
        author: options.author ?? resolveCurrentAgentName(cwd),
        tags: ['capability', ...(options.tag ?? [])],
    };
    // For now, store as decision to avoid schema migration
    // Will migrate to separate capability storage in v0.16
    state.recent_decisions.push(entry);
    persistState(state, cwd);
    console.log(`✔ Capability added: [${id}] ${name}`);
    console.log('  (Stored in decisions for now; will move to dedicated registry in v0.16)');
}
function runCapabilityDescribe(capId, cwd) {
    const state = loadState(cwd);
    const decision = state.recent_decisions.find((d) => d.id === capId || d.short_label === capId);
    if (!decision) {
        console.error(`Error: capability '${capId}' not found`);
        process.exit(1);
    }
    console.log(`\nCapability: ${decision.text}`);
    console.log(`ID: ${decision.id}`);
    console.log(`Author: ${decision.author}`);
    console.log(`Created: ${decision.created_at}`);
    if (decision.tags.length > 1) {
        console.log(`Tags: ${decision.tags.filter((t) => t !== 'capability').join(', ')}`);
    }
    console.log('');
}
//# sourceMappingURL=capability.js.map