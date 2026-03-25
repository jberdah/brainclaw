import { memoryExists } from '../core/io.js';
import { buildProjectDiscovery, saveDiscoveryProfile, renderDiscoverySummary, } from '../core/project-discovery.js';
export function runDiscover(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    if (!memoryExists(cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const profile = buildProjectDiscovery({ cwd });
    // Save by default (non-destructive refresh)
    if (options.save !== false) {
        saveDiscoveryProfile(profile, cwd);
    }
    if (options.json) {
        console.log(JSON.stringify(profile, null, 2));
    }
    else {
        console.log(renderDiscoverySummary(profile));
    }
}
//# sourceMappingURL=discover.js.map