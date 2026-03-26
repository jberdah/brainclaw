import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from '../core/io.js';
export function runUsage(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const usagePath = path.join(memoryDir(cwd), 'usage.jsonl');
    if (!fs.existsSync(usagePath)) {
        if (options.json) {
            console.log(JSON.stringify({ records: 0, message: 'No usage data yet. MCP tool calls will be tracked automatically.' }));
        }
        else {
            console.log('No usage data yet. MCP tool calls will be tracked automatically.');
        }
        return;
    }
    const lines = fs.readFileSync(usagePath, 'utf-8').split('\n').filter(Boolean);
    const cutoff = options.days ? Date.now() - options.days * 86_400_000 : 0;
    const records = [];
    for (const line of lines) {
        try {
            const r = JSON.parse(line);
            if (cutoff && Date.parse(r.ts) < cutoff)
                continue;
            if (options.agent && r.agent !== options.agent)
                continue;
            if (options.tool && r.tool !== options.tool)
                continue;
            records.push(r);
        }
        catch { /* skip malformed */ }
    }
    if (records.length === 0) {
        if (options.json) {
            console.log(JSON.stringify({ records: 0, filters: { agent: options.agent, tool: options.tool, days: options.days } }));
        }
        else {
            console.log('No matching usage records.');
        }
        return;
    }
    // Aggregate by agent → tool
    const byAgent = {};
    for (const r of records) {
        const agentKey = r.agent ?? 'unknown';
        if (!byAgent[agentKey]) {
            byAgent[agentKey] = { calls: 0, total_chars: 0, total_tokens_est: 0, tools: {} };
        }
        const agent = byAgent[agentKey];
        agent.calls++;
        agent.total_chars += r.chars;
        agent.total_tokens_est += r.tokens_est;
        if (!agent.tools[r.tool]) {
            agent.tools[r.tool] = { calls: 0, total_chars: 0, total_tokens_est: 0, errors: 0 };
        }
        const tool = agent.tools[r.tool];
        tool.calls++;
        tool.total_chars += r.chars;
        tool.total_tokens_est += r.tokens_est;
        if (r.is_error)
            tool.errors++;
    }
    const totalChars = records.reduce((s, r) => s + r.chars, 0);
    const totalTokens = records.reduce((s, r) => s + r.tokens_est, 0);
    if (options.json) {
        console.log(JSON.stringify({
            records: records.length,
            total_chars: totalChars,
            total_tokens_est: totalTokens,
            by_agent: byAgent,
            filters: { agent: options.agent, tool: options.tool, days: options.days },
        }, null, 2));
        return;
    }
    // Render table
    const periodLabel = options.days ? `last ${options.days} day(s)` : 'all time';
    console.log(`Brainclaw context usage (${periodLabel}) — ${records.length} MCP call(s)\n`);
    console.log(`  Total: ${formatChars(totalChars)} (~${formatTokens(totalTokens)} tokens)\n`);
    for (const [agentName, stats] of Object.entries(byAgent).sort((a, b) => b[1].total_tokens_est - a[1].total_tokens_est)) {
        console.log(`  ${agentName}: ${stats.calls} calls, ${formatChars(stats.total_chars)} (~${formatTokens(stats.total_tokens_est)} tokens)`);
        const sortedTools = Object.entries(stats.tools).sort((a, b) => b[1].total_tokens_est - a[1].total_tokens_est);
        for (const [toolName, toolStats] of sortedTools) {
            const errSuffix = toolStats.errors > 0 ? ` (${toolStats.errors} errors)` : '';
            const shortName = toolName.replace(/^bclaw_/, '');
            console.log(`    ${shortName}: ${toolStats.calls}× ${formatChars(toolStats.total_chars)}${errSuffix}`);
        }
    }
}
function formatChars(chars) {
    if (chars < 1000)
        return `${chars} chars`;
    if (chars < 1_000_000)
        return `${(chars / 1000).toFixed(1)}K chars`;
    return `${(chars / 1_000_000).toFixed(2)}M chars`;
}
function formatTokens(tokens) {
    if (tokens < 1000)
        return `${tokens}`;
    if (tokens < 1_000_000)
        return `${(tokens / 1000).toFixed(1)}K`;
    return `${(tokens / 1_000_000).toFixed(2)}M`;
}
//# sourceMappingURL=usage.js.map