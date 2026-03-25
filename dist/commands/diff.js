import { memoryExists, memoryPath, readFileSync, writeFileAtomic } from '../core/io.js';
import { loadState } from '../core/state.js';
import { listCandidates, listArchivedCandidates } from '../core/candidates.js';
import { nowISO } from '../core/ids.js';
export function runDiff(options = {}) {
    if (!memoryExists()) {
        console.error('Error: .memory/ not found. Run `team-memory init` first.');
        process.exit(1);
    }
    const markerPath = memoryPath('.last-context');
    const usingMarker = !options.since;
    let since;
    if (options.since) {
        since = new Date(options.since);
        if (isNaN(since.getTime())) {
            console.error(`Error: invalid date '${options.since}'. Use ISO 8601 format, e.g. 2026-03-14T10:00:00Z`);
            process.exit(1);
        }
    }
    else {
        try {
            const ts = readFileSync(markerPath).trim();
            since = new Date(ts);
            if (isNaN(since.getTime()))
                throw new Error('invalid date in .last-context');
        }
        catch {
            console.error('Error: no --since date provided and no .last-context marker found.');
            console.error('Hint: run `team-memory context` first to set the marker, or use:');
            console.error('  team-memory diff --since <ISO date>');
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
            console.log(`No changes in .memory/ since ${sinceISO}`);
        }
        else {
            console.log(`Changes since ${sinceISO}:`);
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
    // When called without explicit --since, advance the marker so the next
    // diff (no --since) starts from here — acts as a cursor.
    if (usingMarker) {
        try {
            writeFileAtomic(markerPath, nowISO());
        }
        catch {
            // Non-fatal
        }
    }
}
//# sourceMappingURL=diff.js.map