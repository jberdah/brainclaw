import { runClaim } from './claim.js';
import { runListClaims } from './list-claims.js';
import { runReleaseClaim } from './release-claim.js';
export function runClaimResource(subcommand, args, options) {
    const normalized = subcommand.trim().toLowerCase();
    if (normalized === 'create') {
        const description = args.join(' ').trim();
        if (!description) {
            console.error('Error: claim create requires <description>');
            process.exit(1);
        }
        if (!options.scope) {
            console.error('Error: claim create requires --scope <scope>');
            process.exit(1);
        }
        runClaim(description, options);
        return;
    }
    if (normalized === 'list' || normalized === 'ls') {
        runListClaims({
            json: options.json,
            all: options.all,
            project: options.project,
            plan: options.plan,
            agent: options.agent,
            cwd: options.cwd,
        });
        return;
    }
    if (normalized === 'release') {
        const id = args[0];
        if (!id) {
            console.error('Error: claim release requires <id>');
            process.exit(1);
        }
        runReleaseClaim(id, {
            planStatus: options.planStatus,
            cwd: options.cwd,
        });
        return;
    }
    // Compatibility path: `brainclaw claim "description" --scope ...`
    const legacyDescription = [subcommand, ...args].join(' ').trim();
    if (!legacyDescription) {
        console.error('Error: missing claim subcommand or description.');
        process.exit(1);
    }
    if (!options.scope) {
        console.error('Error: claim create requires --scope <scope>');
        process.exit(1);
    }
    runClaim(legacyDescription, options);
}
//# sourceMappingURL=claim-resource.js.map