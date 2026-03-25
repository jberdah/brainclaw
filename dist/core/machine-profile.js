import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { MEMORY_DIR } from './io.js';
import { buildAiSurfaceInventory, renderAiSurfaceSummary } from './ai-surface-inventory.js';
// ── Detection Functions ────────────────────────────────────────────────────────
const TOOLCHAINS = [
    { name: 'node', command: 'node', versionArgs: ['--version'] },
    { name: 'npm', command: 'npm', versionArgs: ['--version'] },
    { name: 'pnpm', command: 'pnpm', versionArgs: ['--version'] },
    { name: 'python', command: 'python', versionArgs: ['--version'] },
    { name: 'pip', command: 'pip', versionArgs: ['--version'] },
    { name: 'cargo', command: 'cargo', versionArgs: ['--version'] },
    { name: 'go', command: 'go', versionArgs: ['version'] },
    { name: 'docker', command: 'docker', versionArgs: ['--version'] },
    { name: 'java', command: 'java', versionArgs: ['-version'] },
    { name: 'mvn', command: 'mvn', versionArgs: ['--version'] },
];
function run(command, args, timeout = 5000) {
    try {
        const result = spawnSync(command, args, { encoding: 'utf-8', timeout, windowsHide: true });
        return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
    catch {
        return { ok: false, stdout: '', stderr: '' };
    }
}
function firstLine(text) {
    return text.split(/\r?\n/).map(l => l.trim()).find(Boolean);
}
function detectOsVariant() {
    if (process.platform === 'darwin')
        return 'macos';
    if (process.platform === 'linux')
        return 'linux';
    if (process.platform === 'win32') {
        // Check if WSL2 is available
        const wsl = run('wsl', ['--list', '--quiet'], 3000);
        if (wsl.ok && wsl.stdout.trim().length > 0)
            return 'windows+wsl2';
        return 'windows';
    }
    return 'linux'; // fallback
}
function detectShells() {
    const shells = [];
    const defaultShell = process.env.SHELL ?? process.env.ComSpec ?? '';
    if (process.platform === 'win32') {
        // Windows shells
        const cmd = process.env.ComSpec ?? 'C:\\WINDOWS\\system32\\cmd.exe';
        if (fs.existsSync(cmd)) {
            shells.push({ name: 'cmd', path: cmd, default: cmd === defaultShell });
        }
        // PowerShell
        const ps7 = run('pwsh', ['--version'], 3000);
        if (ps7.ok)
            shells.push({ name: 'pwsh', path: 'pwsh', default: false });
        const ps5 = run('powershell', ['-Command', '$PSVersionTable.PSVersion.ToString()'], 3000);
        if (ps5.ok)
            shells.push({ name: 'powershell', path: 'powershell', default: false });
        // Git Bash
        const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
        if (fs.existsSync(gitBash))
            shells.push({ name: 'bash (git)', path: gitBash, default: false });
    }
    else {
        // Unix shells
        const unixShells = [
            { name: 'bash', command: 'bash' },
            { name: 'zsh', command: 'zsh' },
            { name: 'fish', command: 'fish' },
            { name: 'sh', command: 'sh' },
        ];
        for (const s of unixShells) {
            const which = run('which', [s.command], 2000);
            if (which.ok) {
                const shellPath = which.stdout.trim();
                shells.push({ name: s.name, path: shellPath, default: defaultShell.endsWith(s.command) });
            }
        }
    }
    return shells;
}
function detectGitUsers() {
    const users = [];
    // Global git user
    const globalName = run('git', ['config', '--global', 'user.name']);
    const globalEmail = run('git', ['config', '--global', 'user.email']);
    if (globalName.ok && globalEmail.ok) {
        const name = globalName.stdout.trim();
        const email = globalEmail.stdout.trim();
        if (name && email) {
            users.push({ name, email, scope: 'global' });
        }
    }
    // Try to detect host-specific users from ~/.gitconfig includes
    // (e.g. [includeIf "hasconfig:remote.*.url:git@github.com:*/**"])
    // This is best-effort — we just report the global user for now
    // Local per-repo users are detected during project init, not machine profile
    return users;
}
function detectSshKeys() {
    const keys = [];
    const sshDir = path.join(os.homedir(), '.ssh');
    if (!fs.existsSync(sshDir))
        return keys;
    try {
        const files = fs.readdirSync(sshDir);
        const pubKeys = files.filter(f => f.endsWith('.pub'));
        for (const pubFile of pubKeys) {
            const pubPath = path.join(sshDir, pubFile);
            try {
                const content = fs.readFileSync(pubPath, 'utf-8').trim();
                const parts = content.split(/\s+/);
                const keyType = parts[0] ?? 'unknown';
                const keyName = pubFile.replace(/\.pub$/, '');
                const keyInfo = { name: keyName, path: pubPath, type: keyType };
                // Try to find configured host in ~/.ssh/config
                const configuredHost = findSshConfigHost(sshDir, keyName);
                if (configuredHost)
                    keyInfo.configured_host = configuredHost;
                keys.push(keyInfo);
            }
            catch {
                // Skip unreadable key files
            }
        }
    }
    catch {
        // Skip if directory not readable
    }
    return keys;
}
function findSshConfigHost(sshDir, keyName) {
    const configPath = path.join(sshDir, 'config');
    if (!fs.existsSync(configPath))
        return undefined;
    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const lines = content.split(/\r?\n/);
        let currentHost;
        for (const line of lines) {
            const trimmed = line.trim();
            const hostMatch = trimmed.match(/^Host\s+(.+)/i);
            if (hostMatch) {
                currentHost = hostMatch[1].trim();
                continue;
            }
            const identityMatch = trimmed.match(/^IdentityFile\s+(.+)/i);
            if (identityMatch && currentHost) {
                const identityPath = identityMatch[1].trim().replace(/^~/, os.homedir());
                if (identityPath.includes(keyName)) {
                    return currentHost;
                }
            }
        }
    }
    catch {
        // Non-fatal
    }
    return undefined;
}
function detectToolchains() {
    return TOOLCHAINS.map(tool => {
        const result = run(tool.command, tool.versionArgs);
        if (!result.ok) {
            return { name: tool.name, available: false };
        }
        const versionLine = firstLine(result.stdout || result.stderr) ?? '';
        // Extract version number from various formats
        const versionMatch = versionLine.match(/v?(\d+\.\d+[\w.-]*)/);
        const version = versionMatch ? versionMatch[1] : versionLine;
        // Try to get path
        let toolPath;
        if (process.platform === 'win32') {
            const where = run('where', [tool.command], 3000);
            if (where.ok)
                toolPath = firstLine(where.stdout);
        }
        else {
            const which = run('which', [tool.command], 2000);
            if (which.ok)
                toolPath = which.stdout.trim();
        }
        return { name: tool.name, available: true, version, path: toolPath };
    });
}
function detectWslDistros() {
    if (process.platform !== 'win32')
        return [];
    const result = run('wsl', ['--list', '--verbose'], 5000);
    if (!result.ok)
        return [];
    const distros = [];
    const lines = result.stdout.split(/\r?\n/).filter(l => l.trim());
    // Skip header line (NAME STATE VERSION)
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        // Clean null bytes (common in wsl --list output on Windows)
        const cleaned = line.replace(/\0/g, '').trim();
        if (!cleaned)
            continue;
        const isDefault = cleaned.startsWith('*');
        const parts = cleaned.replace(/^\*\s*/, '').trim().split(/\s+/);
        const name = parts[0];
        if (!name || name === 'NAME')
            continue;
        const distro = { name, default: isDefault };
        // Detect node inside WSL
        const nodeResult = run('wsl', ['-d', name, '--', 'node', '--version'], 5000);
        if (nodeResult.ok) {
            const ver = firstLine(nodeResult.stdout);
            distro.node_version = ver?.replace(/^v/, '');
            // Get node path inside WSL
            const whichNode = run('wsl', ['-d', name, '--', 'which', 'node'], 3000);
            if (whichNode.ok)
                distro.node_path = whichNode.stdout.trim();
        }
        distros.push(distro);
    }
    return distros;
}
// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Build a complete machine profile by detecting all system capabilities.
 */
export function buildMachineProfile() {
    return {
        schema_version: 2,
        generated_at: new Date().toISOString(),
        hostname: os.hostname(),
        os_user: os.userInfo().username,
        home_dir: os.homedir(),
        os_variant: detectOsVariant(),
        platform: process.platform,
        os_release: os.release(),
        arch: os.arch(),
        shells: detectShells(),
        git_users: detectGitUsers(),
        ssh_keys: detectSshKeys(),
        toolchains: detectToolchains(),
        wsl_distros: detectWslDistros(),
        ai_surfaces: buildAiSurfaceInventory(),
    };
}
/**
 * Path to the machine profile file.
 */
export function machineProfilePath() {
    return path.join(os.homedir(), MEMORY_DIR, 'machine.yaml');
}
/**
 * Save a machine profile to ~/.brainclaw/machine.yaml.
 */
export function saveMachineProfile(profile) {
    const filePath = machineProfilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const content = yaml.stringify(profile, { lineWidth: 120 });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}
/**
 * Load the machine profile from ~/.brainclaw/machine.yaml.
 * Returns undefined if no profile exists.
 */
export function loadMachineProfile() {
    const filePath = machineProfilePath();
    if (!fs.existsSync(filePath))
        return undefined;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return yaml.parse(content);
    }
    catch {
        return undefined;
    }
}
/**
 * Render a human-readable summary of the machine profile.
 */
export function renderMachineProfileSummary(profile) {
    const lines = [];
    const aiSurfaces = profile.ai_surfaces ?? [];
    lines.push(`Machine: ${profile.hostname} (user: ${profile.os_user})`);
    lines.push(`Home: ${profile.home_dir}`);
    lines.push(`OS: ${profile.os_variant} (${profile.platform} ${profile.os_release}, ${profile.arch})`);
    // Shells
    const defaultShell = profile.shells.find(s => s.default);
    const otherShells = profile.shells.filter(s => !s.default);
    if (defaultShell) {
        lines.push(`Default shell: ${defaultShell.name}${defaultShell.path ? ` (${defaultShell.path})` : ''}`);
    }
    if (otherShells.length > 0) {
        lines.push(`Other shells: ${otherShells.map(s => s.name).join(', ')}`);
    }
    // Git users
    if (profile.git_users.length > 0) {
        lines.push(`Git users:`);
        for (const u of profile.git_users) {
            lines.push(`  - ${u.name} <${u.email}> (${u.scope}${u.host ? `, ${u.host}` : ''})`);
        }
    }
    // SSH keys
    if (profile.ssh_keys.length > 0) {
        lines.push(`SSH keys:`);
        for (const k of profile.ssh_keys) {
            lines.push(`  - ${k.name} (${k.type}${k.configured_host ? `, host: ${k.configured_host}` : ''})`);
        }
    }
    // Toolchains
    const available = profile.toolchains.filter(t => t.available);
    const unavailable = profile.toolchains.filter(t => !t.available);
    if (available.length > 0) {
        lines.push(`Toolchains: ${available.map(t => `${t.name} ${t.version ?? ''}`).join(', ').trim()}`);
    }
    if (unavailable.length > 0) {
        lines.push(`Not installed: ${unavailable.map(t => t.name).join(', ')}`);
    }
    // WSL distros
    if (profile.wsl_distros.length > 0) {
        lines.push(`WSL distros:`);
        for (const d of profile.wsl_distros) {
            const nodeInfo = d.node_version ? `node ${d.node_version} at ${d.node_path}` : 'no node';
            lines.push(`  - ${d.name}${d.default ? ' (default)' : ''}: ${nodeInfo}`);
        }
    }
    if (aiSurfaces.length > 0) {
        lines.push(...renderAiSurfaceSummary(aiSurfaces));
    }
    lines.push(`Profile generated: ${profile.generated_at}`);
    return lines.join('\n');
}
//# sourceMappingURL=machine-profile.js.map