import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
function run(command, args, timeout = 5000) {
    try {
        const result = spawnSync(command, args, { encoding: 'utf-8', timeout, windowsHide: true });
        return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
    catch {
        return { ok: false, stdout: '', stderr: '' };
    }
}
function listRunningProcesses(platform) {
    if (platform === 'win32') {
        const result = run('tasklist', ['/FO', 'CSV', '/NH'], 8000);
        if (!result.ok)
            return [];
        return result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.replace(/^"|"$/g, '').split('","')[0] ?? '')
            .map((name) => name.replace(/\.exe$/i, '').toLowerCase())
            .filter(Boolean);
    }
    const result = run('ps', ['-A', '-o', 'comm='], 8000);
    if (!result.ok)
        return [];
    return result.stdout
        .split(/\r?\n/)
        .map((line) => path.basename(line.trim()).toLowerCase())
        .filter(Boolean);
}
function detectWindowsAppxPackages() {
    if (process.platform !== 'win32')
        return [];
    const script = [
        "$patterns = @('OpenAI.ChatGPT-Desktop', '*ChatGPT*', 'Claude', '*Claude*');",
        '$packages = foreach ($pattern in $patterns) { Get-AppxPackage -Name $pattern -ErrorAction SilentlyContinue };',
        '$packages | Sort-Object Name -Unique |',
        'ForEach-Object { "{0}`t{1}`t{2}" -f $_.Name, $_.Version.ToString(), $_.InstallLocation }',
    ].join(' ');
    const result = run('powershell', ['-NoProfile', '-Command', script], 15000);
    if (!result.ok || !result.stdout.trim())
        return [];
    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
        const [name, version, installLocation] = line.split('\t');
        return {
            name: name ?? '',
            version: version || undefined,
            installLocation: installLocation || undefined,
        };
    })
        .filter((row) => row.name);
}
function detectBrowsers(homeDir, platform) {
    const browsers = new Set();
    const commands = platform === 'win32'
        ? ['msedge', 'chrome', 'firefox']
        : platform === 'darwin'
            ? ['open', 'google-chrome', 'firefox', 'safari']
            : ['xdg-open', 'google-chrome', 'chromium-browser', 'chromium', 'firefox'];
    for (const command of commands) {
        const result = run(platform === 'win32' ? 'where' : 'which', [command], 3000);
        if (result.ok)
            browsers.add(command);
    }
    const footprintPaths = platform === 'win32'
        ? [
            path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe'),
        ]
        : platform === 'darwin'
            ? [
                '/Applications/Google Chrome.app',
                '/Applications/Firefox.app',
                '/Applications/Safari.app',
                path.join(homeDir, 'Applications', 'Google Chrome.app'),
            ]
            : [
                path.join(homeDir, '.local', 'share', 'applications'),
                '/usr/share/applications',
            ];
    for (const footprint of footprintPaths) {
        if (fs.existsSync(footprint))
            browsers.add(path.basename(footprint).toLowerCase());
    }
    return [...browsers];
}
function matchProcess(processNames, pattern) {
    return processNames.some((name) => pattern.test(name));
}
function findExistingPath(paths) {
    return paths.find((candidate) => candidate && fs.existsSync(candidate));
}
function matchWindowsAppxPackage(packages, pattern) {
    return packages.find((pkg) => pattern.test(pkg.name));
}
export function buildAiSurfaceInventory(options = {}) {
    const platform = options.platform ?? process.platform;
    const homeDir = options.homeDir ?? os.homedir();
    const processNames = options.processNames ?? listRunningProcesses(platform);
    const windowsAppxPackages = options.windowsAppxPackages ?? (platform === 'win32' ? detectWindowsAppxPackages() : []);
    const browsers = options.browsers ?? detectBrowsers(homeDir, platform);
    const surfaces = [];
    const chatGptAppx = platform === 'win32'
        ? matchWindowsAppxPackage(windowsAppxPackages, /OpenAI\.ChatGPT-Desktop|ChatGPT/i)
        : undefined;
    const chatGptRunning = matchProcess(processNames, /^chatgpt$/i);
    const chatGptInstallLocation = platform === 'darwin'
        ? findExistingPath([
            '/Applications/ChatGPT.app',
            path.join(homeDir, 'Applications', 'ChatGPT.app'),
        ])
        : platform === 'win32'
            ? chatGptAppx?.installLocation
            : undefined;
    const chatGptDetected = Boolean(chatGptRunning || chatGptInstallLocation || chatGptAppx);
    surfaces.push({
        id: `surf_chatgpt_${platform}`,
        product_name: 'chatgpt',
        display_name: 'ChatGPT Desktop',
        surface_kind: platform === 'linux' ? 'web_surface' : 'desktop_ai_app',
        variant: platform === 'win32' ? 'windows_store' : platform === 'darwin' ? 'macos_app' : 'web',
        status: chatGptRunning ? 'detected_running' : chatGptDetected ? 'detected_install' : (platform === 'linux' && browsers.length > 0 ? 'limited' : 'not_detected'),
        running: chatGptRunning,
        install_source: chatGptAppx ? 'appx' : chatGptInstallLocation ? 'bundle' : platform === 'linux' && browsers.length > 0 ? 'web' : undefined,
        install_location: chatGptInstallLocation,
        version: chatGptAppx?.version,
        detection_sources: [
            ...(chatGptAppx ? [`AppX package: ${chatGptAppx.name}`] : []),
            ...(chatGptInstallLocation ? [`install path: ${chatGptInstallLocation}`] : []),
            ...(chatGptRunning ? ['running process: ChatGPT'] : []),
            ...(platform === 'linux' && browsers.length > 0 ? ['browser availability'] : []),
        ],
        supports_mcp: 'unknown',
        supports_remote_connectors: 'unknown',
        supports_local_config: 'limited',
        supports_context_export: 'yes',
        supports_prompt_bootstrap: 'yes',
        supports_safe_write_actions: 'limited',
        interactive_only: true,
        can_edit_code: false,
        recommended_uses: [
            'generate visual concepts and rough assets',
            'draft product copy and polished summaries',
            'prepare slide, email, or launch material from project context',
        ],
    });
    const claudeRunning = matchProcess(processNames, /^claude$/i);
    const claudeAppx = platform === 'win32'
        ? matchWindowsAppxPackage(windowsAppxPackages, /^Claude$/i)
        : undefined;
    const claudeInstallLocation = platform === 'darwin'
        ? findExistingPath([
            '/Applications/Claude.app',
            path.join(homeDir, 'Applications', 'Claude.app'),
        ])
        : platform === 'win32'
            ? (claudeAppx?.installLocation ?? findExistingPath([
                path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Claude', 'Claude.exe'),
                path.join(process.env.LOCALAPPDATA ?? '', 'AnthropicClaude', 'Claude.exe'),
                path.join(process.env.LOCALAPPDATA ?? '', 'Claude'),
                path.join(process.env.APPDATA ?? '', 'Claude'),
            ]))
            : undefined;
    const claudeDetected = Boolean(claudeRunning || claudeInstallLocation);
    surfaces.push({
        id: `surf_claude_desktop_${platform}`,
        product_name: 'claude',
        display_name: 'Claude Desktop',
        surface_kind: platform === 'linux' ? 'web_surface' : 'desktop_ai_app',
        variant: platform === 'darwin' ? 'macos_app' : platform === 'win32' ? 'desktop' : 'web',
        status: claudeRunning ? 'detected_running' : claudeDetected ? 'detected_install' : (platform === 'linux' && browsers.length > 0 ? 'limited' : 'not_detected'),
        running: claudeRunning,
        install_source: claudeAppx ? 'appx' : claudeInstallLocation ? 'bundle' : platform === 'linux' && browsers.length > 0 ? 'web' : undefined,
        install_location: claudeInstallLocation,
        version: claudeAppx?.version,
        detection_sources: [
            ...(claudeAppx ? [`AppX package: ${claudeAppx.name}`] : []),
            ...(claudeInstallLocation ? [`install path: ${claudeInstallLocation}`] : []),
            ...(claudeRunning ? ['running process: Claude'] : []),
            ...(platform === 'linux' && browsers.length > 0 ? ['browser availability'] : []),
        ],
        supports_mcp: platform === 'linux' ? 'limited' : 'yes',
        supports_remote_connectors: platform === 'linux' ? 'limited' : 'yes',
        supports_local_config: platform === 'linux' ? 'limited' : 'yes',
        supports_context_export: 'yes',
        supports_prompt_bootstrap: 'yes',
        supports_safe_write_actions: 'limited',
        interactive_only: true,
        can_edit_code: false,
        recommended_uses: [
            'project synthesis and reasoning-heavy drafting',
            'doc and handoff preparation around a repo',
            'MCP-oriented project context consumption when supported',
        ],
    });
    surfaces.push({
        id: `surf_claude_cowork_${platform}`,
        product_name: 'claude-cowork',
        display_name: 'Claude Cowork',
        surface_kind: 'desktop_embedded_capability',
        variant: 'embedded',
        parent_surface_id: `surf_claude_desktop_${platform}`,
        status: claudeDetected || claudeRunning ? 'limited' : 'not_detected',
        running: false,
        detection_sources: claudeDetected || claudeRunning
            ? ['parent capability: Claude Desktop']
            : [],
        supports_mcp: 'limited',
        supports_remote_connectors: 'limited',
        supports_local_config: 'limited',
        supports_context_export: 'yes',
        supports_prompt_bootstrap: 'yes',
        supports_safe_write_actions: 'limited',
        interactive_only: true,
        can_edit_code: false,
        recommended_uses: [
            'parallel collaboration on non-code deliverables',
            'task follow-up and structured handoff work',
            'operator-facing drafting without repo edits',
        ],
    });
    const geminiCliPath = findExistingPath([
        path.join(homeDir, '.gemini', 'antigravity'),
    ]);
    const geminiCliRunning = matchProcess(processNames, /gemini|antigravity/i);
    const geminiCliVersion = run('gemini', ['--version'], 3000);
    const geminiCliDetected = Boolean(geminiCliPath || geminiCliRunning || geminiCliVersion.ok);
    surfaces.push({
        id: `surf_gemini_cli_${platform}`,
        product_name: 'gemini',
        display_name: 'Gemini CLI / Antigravity',
        surface_kind: 'cli_agent',
        variant: 'antigravity',
        status: geminiCliRunning ? 'detected_running' : geminiCliDetected ? 'brainclaw_ready' : 'not_detected',
        running: geminiCliRunning,
        install_source: geminiCliPath ? 'config_footprint' : geminiCliVersion.ok ? 'cli' : undefined,
        install_location: geminiCliPath,
        version: geminiCliVersion.ok ? geminiCliVersion.stdout.trim() : undefined,
        detection_sources: [
            ...(geminiCliPath ? [`config path: ${geminiCliPath}`] : []),
            ...(geminiCliVersion.ok ? ['gemini --version'] : []),
            ...(geminiCliRunning ? ['running process: gemini/antigravity'] : []),
        ],
        supports_mcp: 'yes',
        supports_remote_connectors: 'unknown',
        supports_local_config: 'yes',
        supports_context_export: 'yes',
        supports_prompt_bootstrap: 'yes',
        supports_safe_write_actions: 'limited',
        interactive_only: false,
        can_edit_code: false,
        recommended_uses: [
            'CLI-driven analysis and automation-adjacent tasks',
            'repo-adjacent reasoning without changing the editing agent',
            'structured use of local MCP and exported context',
        ],
    });
    const geminiWebAvailable = browsers.length > 0;
    surfaces.push({
        id: `surf_gemini_web_${platform}`,
        product_name: 'gemini',
        display_name: 'Gemini Web',
        surface_kind: 'web_surface',
        variant: 'browser',
        status: geminiWebAvailable ? 'limited' : 'not_detected',
        running: matchProcess(processNames, /chrome|msedge|firefox|safari/i),
        install_source: geminiWebAvailable ? 'web' : undefined,
        detection_sources: geminiWebAvailable ? [`browser availability: ${browsers.join(', ')}`] : [],
        supports_mcp: 'unknown',
        supports_remote_connectors: 'unknown',
        supports_local_config: 'limited',
        supports_context_export: 'yes',
        supports_prompt_bootstrap: 'yes',
        supports_safe_write_actions: 'limited',
        interactive_only: true,
        can_edit_code: false,
        recommended_uses: [
            'quick research and synthesis in a browser surface',
            'lightweight planning, summaries, and exploration',
            'prompt-bootstrap workflows when no native integration exists',
        ],
    });
    return surfaces;
}
export function renderAiSurfaceSummary(surfaces) {
    const detected = surfaces.filter((surface) => surface.status !== 'not_detected');
    const lines = [];
    lines.push(`AI surfaces: ${detected.length}/${surfaces.length} detected or available`);
    for (const surface of detected) {
        const details = [surface.surface_kind, surface.status];
        if (surface.variant)
            details.push(surface.variant);
        if (surface.version)
            details.push(surface.version);
        lines.push(`  - ${surface.display_name} (${details.join(', ')})`);
    }
    return lines;
}
export function renderAiSurfaceUsageHints(surfaces) {
    const eligible = surfaces.filter((surface) => surface.status !== 'not_detected');
    const lines = [];
    for (const surface of eligible) {
        if (surface.recommended_uses.length === 0)
            continue;
        lines.push(`${surface.display_name}:`);
        for (const useCase of surface.recommended_uses.slice(0, 2)) {
            lines.push(`  - ${useCase}`);
        }
    }
    return lines;
}
//# sourceMappingURL=ai-surface-inventory.js.map