import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const MAX_AGENT_RULES = 5;
const MAX_SKILLS = 25;
const skillsCache = new Map();
const mcpCache = new Map();
export function buildAgentToolingContext(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const agents = readAgentsMarkdown(cwd);
    return {
        agents_md_present: agents.present,
        agents_md_title: agents.title,
        agents_rules: agents.rules,
        skills: listSkills(cwd, env),
        mcp_servers: listMcpServers(cwd, env),
    };
}
export function renderAgentToolingSummary(snapshot) {
    const lines = [];
    lines.push(`AGENTS.md: ${snapshot.agents_md_present ? 'present' : 'absent'}`);
    if (snapshot.agents_md_title) {
        lines.push(`AGENTS title: ${snapshot.agents_md_title}`);
    }
    if (snapshot.agents_rules.length > 0) {
        lines.push('Agent rules:');
        for (const rule of snapshot.agents_rules) {
            lines.push(`- ${rule}`);
        }
    }
    lines.push(`Skills: ${snapshot.skills.length}`);
    for (const skill of snapshot.skills.slice(0, 10)) {
        const markers = [];
        if (skill.scripts_present)
            markers.push('scripts');
        if (skill.references_present)
            markers.push('references');
        if (skill.assets_present)
            markers.push('assets');
        const suffix = markers.length > 0 ? ` [${markers.join(', ')}]` : '';
        lines.push(`- ${skill.name}${skill.description ? `: ${skill.description}` : ''}${suffix}`);
    }
    lines.push(`MCP servers: ${snapshot.mcp_servers.length}`);
    for (const server of snapshot.mcp_servers.slice(0, 10)) {
        const availability = server.availability === 'available'
            ? 'available'
            : server.availability === 'missing_command'
                ? 'missing command'
                : server.availability;
        lines.push(`- ${server.name} (${server.transport}, ${availability})${server.command ? ` via ${server.command}` : ''}`);
    }
    return lines.join('\n');
}
function readAgentsMarkdown(cwd) {
    const filepath = path.join(cwd, 'AGENTS.md');
    if (!fs.existsSync(filepath)) {
        return { present: false, rules: [] };
    }
    const raw = fs.readFileSync(filepath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const title = lines.find((line) => line.trim().startsWith('#'))?.replace(/^#+\s*/, '').trim();
    // Only extract rules from actionable sections, not from descriptive sections
    // like "why this matters" which contain explanatory bullets, not instructions.
    const SKIP_SECTIONS = /why this matters|what it provides|what brainclaw/i;
    let currentSection = '';
    let skipSection = false;
    const rules = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) {
            currentSection = trimmed.replace(/^#+\s*/, '');
            skipSection = SKIP_SECTIONS.test(currentSection);
            continue;
        }
        if (skipSection)
            continue;
        if (/^([-*]|\d+\.)\s+/.test(trimmed)) {
            const text = trimmed.replace(/^([-*]|\d+\.)\s+/, '').trim();
            if (text) {
                rules.push(text);
                if (rules.length >= MAX_AGENT_RULES)
                    break;
            }
        }
    }
    return {
        present: true,
        title,
        rules,
    };
}
function listSkills(cwd, env) {
    const cacheKey = skillCacheKey(cwd, env);
    const cached = skillsCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const items = [];
    const seen = new Set();
    for (const skillsDir of skillDirectories(cwd, env)) {
        if (!fs.existsSync(skillsDir)) {
            continue;
        }
        for (const filepath of findSkillFiles(skillsDir)) {
            if (seen.has(filepath)) {
                continue;
            }
            seen.add(filepath);
            const skill = readSkill(filepath);
            if (skill) {
                items.push(skill);
            }
        }
    }
    const result = items
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_SKILLS);
    skillsCache.set(cacheKey, result);
    return result;
}
function listMcpServers(cwd, env) {
    const cacheKey = mcpCacheKey(cwd, env);
    const cached = mcpCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const items = [];
    const seen = new Set();
    for (const configPath of configFiles(cwd, env)) {
        if (!fs.existsSync(configPath) || seen.has(configPath)) {
            continue;
        }
        seen.add(configPath);
        items.push(...readMcpConfig(configPath, cwd, env));
    }
    const result = items.sort((left, right) => left.name.localeCompare(right.name));
    mcpCache.set(cacheKey, result);
    return result;
}
function readSkill(filepath) {
    try {
        const raw = fs.readFileSync(filepath, 'utf-8');
        const lines = raw.split(/\r?\n/).map((line) => line.trim());
        const description = lines.find((line) => isUsefulDescriptionLine(line));
        const skillDir = path.dirname(filepath);
        return {
            name: path.basename(path.dirname(filepath)),
            description: description && description.length <= 160 ? description : undefined,
            source_path: filepath,
            scripts_present: fs.existsSync(path.join(skillDir, 'scripts')),
            references_present: fs.existsSync(path.join(skillDir, 'references')),
            assets_present: fs.existsSync(path.join(skillDir, 'assets')),
        };
    }
    catch {
        return undefined;
    }
}
function findSkillFiles(root) {
    const files = [];
    walkSkillDir(root, files);
    return files;
}
function walkSkillDir(dir, files) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkSkillDir(fullPath, files);
            continue;
        }
        if (entry.isFile() && entry.name === 'SKILL.md') {
            files.push(fullPath);
        }
    }
}
function readMcpConfig(configPath, cwd, env) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const items = [];
    let current;
    for (const line of lines) {
        const trimmed = line.trim();
        const sectionMatch = /^\[mcp_servers\.([A-Za-z0-9_.-]+)\]$/.exec(trimmed);
        if (sectionMatch) {
            if (current) {
                items.push(toMcpServerItem(current, configPath, cwd, env));
            }
            current = { name: sectionMatch[1] };
            continue;
        }
        if (!current) {
            continue;
        }
        if (trimmed.startsWith('[')) {
            items.push(toMcpServerItem(current, configPath, cwd, env));
            current = undefined;
            continue;
        }
        const commandMatch = /^command\s*=\s*"([^"]+)"/.exec(trimmed);
        if (commandMatch) {
            current.command = commandMatch[1];
            continue;
        }
        const urlMatch = /^url\s*=\s*"([^"]+)"/.exec(trimmed);
        if (urlMatch) {
            current.url = urlMatch[1];
            continue;
        }
        const argsMatch = /^args\s*=\s*\[(.+)\]/.exec(trimmed);
        if (argsMatch) {
            current.args = argsMatch[1];
        }
    }
    if (current) {
        items.push(toMcpServerItem(current, configPath, cwd, env));
    }
    return items;
}
function toMcpServerItem(record, configPath, cwd, env) {
    const combined = `${record.url ?? ''} ${record.args ?? ''}`.toLowerCase();
    const transport = record.url || combined.includes('http://') || combined.includes('https://')
        ? 'remote'
        : record.command
            ? 'stdio'
            : 'unknown';
    const availability = transport === 'remote'
        ? 'remote'
        : transport === 'stdio'
            ? (commandExists(record.command ?? '', cwd, env) ? 'available' : 'missing_command')
            : 'unknown';
    return {
        name: record.name,
        transport,
        command: record.command,
        config_path: configPath,
        availability,
        source: resolveConfigSource(configPath, cwd, env),
    };
}
function skillDirectories(cwd, env) {
    const roots = codexHomes(cwd, env);
    return roots.map((root) => path.join(root, 'skills'));
}
function configFiles(cwd, env) {
    return codexHomes(cwd, env).map((root) => path.join(root, 'config.toml'));
}
function codexHomes(cwd, env) {
    const explicit = env.CODEX_HOME?.trim();
    if (explicit) {
        return [...new Set([
                explicit,
                path.join(cwd, '.codex'),
            ])];
    }
    return [...new Set([
            path.join(cwd, '.codex'),
            path.join(os.homedir(), '.codex'),
        ])];
}
function isUsefulDescriptionLine(line) {
    if (!line) {
        return false;
    }
    if (line.startsWith('#')) {
        return false;
    }
    if (line === '---') {
        return false;
    }
    if (/^[A-Za-z0-9_-]+:\s*$/.test(line)) {
        return false;
    }
    return true;
}
function resolveConfigSource(configPath, cwd, env) {
    const normalized = path.normalize(configPath);
    const workspaceCodex = path.normalize(path.join(cwd, '.codex'));
    const explicitCodexHome = env.CODEX_HOME?.trim();
    if (isWithinPath(normalized, workspaceCodex)) {
        return 'workspace';
    }
    if (explicitCodexHome && isWithinPath(normalized, path.normalize(explicitCodexHome))) {
        return 'codex_home';
    }
    return 'home';
}
function commandExists(command, cwd, env) {
    const trimmed = command.trim();
    if (!trimmed) {
        return false;
    }
    if (trimmed.includes(path.sep) || trimmed.includes('/')) {
        const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
        return fileExists(candidate);
    }
    const pathValue = env.PATH ?? env.Path ?? '';
    if (!pathValue) {
        return false;
    }
    const extensions = process.platform === 'win32'
        ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
        if (process.platform === 'win32') {
            const hasKnownExt = /\.[A-Za-z0-9]+$/.test(trimmed);
            const candidates = hasKnownExt ? [trimmed] : extensions.map((ext) => `${trimmed}${ext}`);
            for (const candidate of candidates) {
                if (fileExists(path.join(dir, candidate))) {
                    return true;
                }
            }
            continue;
        }
        if (fileExists(path.join(dir, trimmed))) {
            return true;
        }
    }
    return false;
}
function fileExists(filepath) {
    try {
        return fs.existsSync(filepath) && fs.statSync(filepath).isFile();
    }
    catch {
        return false;
    }
}
function skillCacheKey(cwd, env) {
    const parts = [];
    for (const skillsDir of skillDirectories(cwd, env)) {
        parts.push(skillsDir);
        if (!fs.existsSync(skillsDir)) {
            continue;
        }
        for (const filepath of findSkillFiles(skillsDir)) {
            parts.push(`${filepath}:${safeMtime(filepath)}`);
        }
    }
    return parts.join('|');
}
function mcpCacheKey(cwd, env) {
    const parts = configFiles(cwd, env).map((configPath) => `${configPath}:${safeMtime(configPath)}`);
    parts.push(env.PATH ?? '', env.Path ?? '', env.PATHEXT ?? '');
    return parts.join('|');
}
function safeMtime(filepath) {
    try {
        return fs.statSync(filepath).mtimeMs;
    }
    catch {
        return 0;
    }
}
function isWithinPath(filepath, root) {
    return filepath === root || filepath.startsWith(`${root}${path.sep}`);
}
//# sourceMappingURL=agent-context.js.map