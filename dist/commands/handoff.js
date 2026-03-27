import { execSync } from 'node:child_process';
import { loadState, persistState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists } from '../core/io.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore } from '../core/store-resolution.js';
export function runHandoff(text, options) {
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
    const plan = options.plan ? state.plan_items.find((item) => item.id === options.plan) : undefined;
    if (options.plan && !plan) {
        console.error(`Error: Plan item '${options.plan}' not found.`);
        process.exit(1);
    }
    const { id, short_label } = generateIdWithLabel('open_handoffs');
    let diff;
    if (options.captureDiff) {
        try {
            diff = execSync('git diff HEAD', { encoding: 'utf-8' });
        }
        catch {
            diff = "Could not capture git diff.";
        }
    }
    const contract = buildContract(options, diff);
    const entry = {
        id,
        short_label,
        from: options.from,
        to: options.to,
        text,
        created_at: nowISO(),
        author: options.author ?? resolveCurrentAgentName(cwd),
        status: 'open',
        project: options.project ?? plan?.project,
        plan_id: options.plan,
        tags: options.tag ?? [],
        related_paths: options.path,
        contract,
        snapshot: diff ? { diff } : undefined,
    };
    state.open_handoffs.push(entry);
    persistState(state, cwd);
    console.log(`✔ Handoff added: [${id}] ${options.from} → ${options.to}: ${text}`);
}
export function extractFilesFromDiff(diff) {
    const files = new Set();
    for (const line of diff.split('\n')) {
        // Match "diff --git a/path b/path" or "+++ b/path" or "--- a/path"
        const gitDiffMatch = line.match(/^diff --git a\/(.+?) b\//);
        if (gitDiffMatch) {
            files.add(gitDiffMatch[1]);
            continue;
        }
        const plusMatch = line.match(/^\+\+\+ b\/(.+)/);
        if (plusMatch && plusMatch[1] !== '/dev/null') {
            files.add(plusMatch[1]);
        }
    }
    return [...files].sort();
}
function buildContract(options, diff) {
    const hasExplicit = options.files?.length || options.preCondition?.length ||
        options.postCondition?.length || options.test?.length || options.linkedPlan?.length;
    const filesFromDiff = diff ? extractFilesFromDiff(diff) : [];
    const allFiles = [...new Set([...(options.files ?? []), ...filesFromDiff])].sort();
    if (!hasExplicit && allFiles.length === 0)
        return undefined;
    return {
        files_touched: allFiles.length > 0 ? allFiles : undefined,
        pre_conditions: options.preCondition?.length ? options.preCondition : undefined,
        post_conditions: options.postCondition?.length ? options.postCondition : undefined,
        tests_to_verify: options.test?.length ? options.test : undefined,
        linked_plans: options.linkedPlan?.length ? options.linkedPlan : undefined,
    };
}
//# sourceMappingURL=handoff.js.map