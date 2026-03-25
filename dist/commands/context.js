import { memoryExists } from '../core/io.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../core/context.js';
import { writeContextMarker } from '../core/freshness.js';
import { nowISO } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { resolveContextStoreCwd } from '../core/store-resolution.js';
export function runContext(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    if (!memoryExists(cwd)) {
        if (options.json) {
            console.log(JSON.stringify({
                initialized: false,
                action_required: 'Run `brainclaw init` to initialize project memory.',
            }, null, 2));
        }
        else {
            console.log('brainclaw: project memory not initialized. Run `brainclaw init` first.');
        }
        return;
    }
    const contextCwd = resolveContextStoreCwd(cwd, options.for);
    const result = buildContext({
        target: options.for,
        project: options.project,
        agent: options.agent,
        host: options.host,
        allHosts: options.allHosts,
        includePending: options.includePending,
        profile: options.profile,
        maxItems: options.maxItems,
        maxChars: options.maxChars,
        digest: options.digest,
        bootstrap: options.bootstrap,
        refreshBootstrap: options.refreshBootstrap,
        sinceSession: options.sinceSession,
        cwd,
    });
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
    }
    else if (options.template) {
        const compact = options.compactTemplate || result.profile === 'openclaw';
        console.log(renderContextPromptTemplate(result, compact));
    }
    else {
        console.log(renderContextMarkdown(result, options.explain));
    }
    writeLastContextMarker(result, options, contextCwd);
}
function writeLastContextMarker(result, options, cwd) {
    try {
        writeContextMarker({
            read_at: nowISO(),
            memory_version: result.memory_version,
            host_id: result.current_host,
            target: options.for,
            project: result.project,
            all_hosts: options.allHosts ?? false,
        }, cwd);
    }
    catch (err) {
        logger.debug('Failed to write context marker:', err);
    }
}
//# sourceMappingURL=context.js.map