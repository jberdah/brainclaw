import { loadState, persistState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists } from '../core/io.js';
import { validateCliInput } from '../core/input-validation.js';
import { runListPlans } from './list-plans.js';
import { resolveTargetStore } from '../core/store-resolution.js';
// Known plan subcommands that should not be accepted as plan text
const PLAN_SUBCOMMAND_ALIASES = new Set(['list', 'ls']);
const PLAN_SUBCOMMAND_ERRORS = new Set(['update']);
export function runPlan(text, options = {}) {
    const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
    if (!memoryExists(cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const normalized = text.trim().toLowerCase();
    if (PLAN_SUBCOMMAND_ALIASES.has(normalized)) {
        runListPlans({});
        return;
    }
    if (PLAN_SUBCOMMAND_ERRORS.has(normalized)) {
        console.error(`Error: '${text}' looks like a subcommand, not a plan description.`);
        console.error('  To update a plan, use: brainclaw plan update <id> --status <status>');
        process.exit(1);
    }
    validateCliInput(text, options.tag);
    const config = loadConfig(cwd);
    const warnings = scanText(text, config);
    for (const w of warnings) {
        console.warn(`⚠ ${w.message}`);
        if (w.level === 'block') {
            console.error('Blocked: strict redaction is enabled. Entry not added.');
            process.exit(1);
        }
    }
    // Validate and normalise --estimate: must be a positive integer (minutes)
    let estimatedEffort;
    if (options.estimate !== undefined) {
        const n = typeof options.estimate === 'number' ? options.estimate : parseInt(String(options.estimate), 10);
        if (!Number.isInteger(n) || n <= 0) {
            console.error('Error: --estimate must be a positive integer representing minutes (e.g. --estimate 30)');
            process.exit(1);
        }
        estimatedEffort = n;
    }
    const state = loadState(cwd);
    const { id, short_label } = generateIdWithLabel('plan_items');
    const timestamp = nowISO();
    const entry = {
        id,
        short_label,
        text,
        type: options.type,
        created_at: timestamp,
        updated_at: timestamp,
        author: options.author ?? resolveCurrentAgentName(cwd),
        status: 'todo',
        priority: options.priority ?? 'medium',
        assignee: options.assignee,
        project: options.project,
        tags: options.tag ?? [],
        related_paths: options.path,
        depends_on: options.dependsOn ?? [],
        estimated_effort: estimatedEffort,
    };
    state.plan_items.push(entry);
    persistState(state, cwd);
    const storeLabel = options.store && options.store !== 'local' ? ` [store:${options.store}]` : '';
    console.log(`✔ Plan item added: [${id}] ${text}${storeLabel}`);
}
//# sourceMappingURL=plan.js.map