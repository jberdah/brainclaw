import { memoryExists } from '../core/io.js';
import { getVisibleMemoryVersion, readContextMarker, writeContextMarker } from '../core/freshness.js';
import { loadState } from '../core/state.js';
import { listCandidates, listArchivedCandidates } from '../core/candidates.js';
import { nowISO } from '../core/ids.js';
import { logger } from '../core/logger.js';
export function runDiff(options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const usingMarker = !options.since;
    let since;
    const marker = usingMarker ? readContextMarker() : undefined;
    if (options.since) {
        since = new Date(options.since);
        if (isNaN(since.getTime())) {
            console.error(`Error: invalid date '${options.since}'. Use ISO 8601 format, e.g. 2026-03-14T10:00:00Z`);
            process.exit(1);
        }
    }
    else {
        if (!marker) {
            console.error('Error: no --since date provided and no .last-context marker found.');
            console.error('Hint: Run `brainclaw context` first to set the marker, or use:');
            console.error('  brainclaw diff --since <ISO date>');
            process.exit(1);
        }
        since = new Date(marker.read_at);
        if (isNaN(since.getTime())) {
            console.error('Error: invalid date in .last-context marker.');
            process.exit(1);
        }
    }
    const sinceISO = since.toISOString();
    const state = loadState();
    const makeEntry = (section, type) => (e) => ({
        id: e.id, entry_type: type, section, text: e.text, created_at: e.created_at,
    });
    const stateEntries = [
        ...state.active_constraints.filter(e => e.created_at > sinceISO).map(makeEntry('active_constraints', 'constraint')),
        ...state.recent_decisions.filter(e => e.created_at > sinceISO).map(makeEntry('recent_decisions', 'decision')),
        ...state.known_traps.filter(e => e.created_at > sinceISO).map(makeEntry('known_traps', 'trap')),
        ...state.open_handoffs.filter(e => e.created_at > sinceISO).map(makeEntry('open_handoffs', 'handoff')),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const newPending = listCandidates('pending').filter(c => c.created_at > sinceISO);
    const newAccepted = listArchivedCandidates('accepted').filter(c => (c.resolved_at ?? c.created_at) > sinceISO);
    const total = stateEntries.length + newPending.length + newAccepted.length;
    if (options.json) {
        console.log(JSON.stringify({
            since: sinceISO,
            checked_at: new Date().toISOString(),
            total_changes: total,
            state_entries: stateEntries,
            new_candidates: newPending,
            accepted_candidates: newAccepted,
        }, null, 2));
    }
    else {
        if (total === 0) {
            console.log(`No changes in .brainclaw/ since ${sinceISO}`);
        }
        else {
            console.log(`Changes since ${sinceISO}:`);
            if (marker?.memory_version) {
                const currentVersion = getVisibleMemoryVersion();
                if (marker.memory_version !== currentVersion) {
                    console.log(`Visible memory version changed: ${marker.memory_version} -> ${currentVersion}`);
                    console.log('');
                }
            }
            console.log('');
            if (stateEntries.length > 0) {
                console.log(`New canonical entries (${stateEntries.length}):`);
                for (const e of stateEntries) {
                    console.log(`  + [${e.id}] (${e.entry_type}) ${e.text}`);
                }
            }
            if (newPending.length > 0) {
                if (stateEntries.length > 0)
                    console.log('');
                console.log(`New candidates pending review (${newPending.length}):`);
                for (const c of newPending) {
                    console.log(`  ? [${c.id}] (${c.type}) ${c.text}`);
                }
            }
            if (newAccepted.length > 0) {
                console.log('');
                console.log(`Candidates accepted into memory (${newAccepted.length}):`);
                for (const c of newAccepted) {
                    console.log(`  \u2714 [${c.id}] (${c.type}) ${c.text}`);
                }
            }
        }
    }
    if (usingMarker) {
        try {
            writeContextMarker({
                read_at: nowISO(),
                memory_version: getVisibleMemoryVersion(),
                host_id: marker?.host_id,
                target: marker?.target,
                project: marker?.project,
                all_hosts: marker?.all_hosts,
            });
        }
        catch (err) {
            logger.debug('Failed to write context marker:', err);
        }
    }
}
//# sourceMappingURL=changes.js.map