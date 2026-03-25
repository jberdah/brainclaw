import { loadState, persistState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists } from '../core/io.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore } from '../core/store-resolution.js';
export function runConstraint(text, options = {}) {
    const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
    if (!memoryExists(cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
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
    const state = loadState(cwd);
    const { id, short_label } = generateIdWithLabel('active_constraints');
    const entry = {
        id,
        short_label,
        text,
        created_at: nowISO(),
        author: options.author ?? resolveCurrentAgentName(cwd),
        status: 'active',
        category: options.category,
        tags: options.tag ?? [],
        related_paths: options.path,
    };
    state.active_constraints.push(entry);
    persistState(state, cwd);
    console.log(`✔ Constraint added: [${id}] ${text}`);
}
//# sourceMappingURL=constraint.js.map