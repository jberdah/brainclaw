import { memoryExists } from '../core/io.js';
import { search } from '../core/search.js';
export function runSearch(query, options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const results = search({
        query,
        section: options.section,
        since: options.since,
        tags: options.tag,
        includePending: options.pending,
        maxResults: options.maxResults ?? 20,
    });
    if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
    }
    if (results.length === 0) {
        console.log(`No results for "${query}".`);
        return;
    }
    console.log(`Found ${results.length} result(s) for "${query}":\n`);
    for (const r of results) {
        const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : '';
        const paths = r.related_paths && r.related_paths.length > 0 ? ` (${r.related_paths.join(', ')})` : '';
        const score = r.score > 0 ? ` (score: ${r.score})` : '';
        console.log(`  [${r.id}] <${r.section}>${tags}${paths}${score}`);
        console.log(`    ${r.text}`);
        if (r.author)
            console.log(`    — ${r.author}, ${r.created_at.slice(0, 10)}`);
        console.log();
    }
}
//# sourceMappingURL=search.js.map