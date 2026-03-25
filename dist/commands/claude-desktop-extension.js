import path from 'node:path';
import { buildClaudeDesktopExtension, renderClaudeDesktopExtensionSummary, } from '../core/claude-desktop-extension.js';
export function runClaudeDesktopExtension(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const result = buildClaudeDesktopExtension({
        cwd,
        workspaceDir: options.workspace ? path.resolve(cwd, options.workspace) : undefined,
        outputFile: options.output ? path.resolve(cwd, options.output) : undefined,
        projectRoot: options.projectRoot ? path.resolve(cwd, options.projectRoot) : undefined,
        pack: options.pack,
    });
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    console.log(renderClaudeDesktopExtensionSummary(result));
}
//# sourceMappingURL=claude-desktop-extension.js.map