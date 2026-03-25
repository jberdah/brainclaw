import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { memoryExists } from './io.js';
const CLAUDE_DESKTOP_TOOLS = [
    { name: 'bclaw_session_start', description: 'Open a Brainclaw session and surface Claude-targeted tasks plus compact execution context.' },
    { name: 'bclaw_get_context', description: 'Retrieve ranked Brainclaw project context for the current task or path.' },
    { name: 'bclaw_list_surface_tasks', description: 'List queued or completed Brainclaw tasks delegated to Claude Desktop.' },
    { name: 'bclaw_update_surface_task', description: 'Mark a delegated Claude Desktop task as in progress or completed.' },
];
export function buildClaudeDesktopExtension(options = {}) {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    if (!memoryExists(cwd)) {
        throw new Error('Project memory not initialized. Run `brainclaw init` first.');
    }
    const workspaceDir = path.resolve(options.workspaceDir ?? path.join(cwd, 'internal-docs', 'desktop-extensions', 'claude-desktop-brainclaw'));
    const outputFile = path.resolve(options.outputFile ?? path.join(cwd, 'internal-docs', 'desktop-extensions', 'brainclaw-claude-desktop.mcpb'));
    if (outputFile.startsWith(`${workspaceDir}${path.sep}`) || outputFile === workspaceDir) {
        throw new Error('The .mcpb output file must live outside the extension workspace directory.');
    }
    const projectRoot = path.resolve(options.projectRoot ?? cwd);
    const runtimeRoot = path.resolve(options.runtimeRootOverride ?? resolveRuntimeRoot());
    const packageRoot = path.resolve(options.packageRootOverride ?? findPackageRoot(runtimeRoot));
    const metadata = readPackageMetadata(packageRoot);
    const copiedDependencies = options.dependenciesOverride ?? resolveRuntimeDependencies(packageRoot);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.cpSync(runtimeRoot, path.join(workspaceDir, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'server'), { recursive: true });
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    for (const dep of copiedDependencies) {
        const sourceDir = path.join(packageRoot, 'node_modules', dep);
        if (!fs.existsSync(sourceDir)) {
            throw new Error(`Missing runtime dependency for Claude Desktop extension: ${dep}`);
        }
        fs.cpSync(sourceDir, path.join(workspaceDir, 'node_modules', dep), { recursive: true });
    }
    const version = metadata.version ?? '0.0.0';
    const manifestPath = path.join(workspaceDir, 'manifest.json');
    const entryPointPath = path.join(workspaceDir, 'server', 'index.js');
    const packageJsonPath = path.join(workspaceDir, 'package.json');
    fs.writeFileSync(entryPointPath, buildServerEntryPoint(), 'utf-8');
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({
        name: 'brainclaw-claude-desktop-extension',
        private: true,
        type: 'module',
        version,
    }, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(manifestPath, `${JSON.stringify(buildManifest(metadata, version, projectRoot), null, 2)}\n`, 'utf-8');
    const packed = options.pack !== false ? packClaudeDesktopExtension(workspaceDir, outputFile) : false;
    return {
        workspaceDir,
        outputFile,
        packed,
        manifestPath,
        entryPointPath,
        packageRoot,
        runtimeRoot,
        projectRoot,
        copiedDependencies,
    };
}
function buildServerEntryPoint() {
    return `import process from 'node:process';

const projectRoot = process.env.BRAINCLAW_PROJECT_ROOT?.trim();
if (projectRoot) {
  process.chdir(projectRoot);
}

const { runMcp } = await import('../runtime/commands/mcp.js');
runMcp();
`;
}
function buildManifest(metadata, version, projectRoot) {
    return {
        manifest_version: '0.3',
        name: 'brainclaw-claude-desktop',
        display_name: 'Brainclaw Project Memory',
        version,
        description: 'Brainclaw local project memory and delegated task inbox for Claude Desktop.',
        author: {
            name: 'Brainclaw',
            ...(metadata.homepage ? { url: metadata.homepage } : {}),
        },
        ...(typeof metadata.repository === 'string'
            ? { repository: { type: 'git', url: metadata.repository } }
            : metadata.repository
                ? { repository: metadata.repository }
                : {}),
        ...(metadata.homepage ? { homepage: metadata.homepage } : {}),
        server: {
            type: 'node',
            entry_point: 'server/index.js',
            mcp_config: {
                command: 'node',
                args: ['${__dirname}/server/index.js'],
                env: {
                    BRAINCLAW_PROJECT_ROOT: '${user_config.project_root}',
                    BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
                },
            },
        },
        tools: CLAUDE_DESKTOP_TOOLS,
        compatibility: {
            platforms: ['win32', 'darwin'],
            runtimes: {
                node: '>=20.0.0',
            },
        },
        user_config: {
            project_root: {
                type: 'directory',
                title: 'Project Root',
                description: 'Brainclaw project root that Claude Desktop should operate on.',
                required: true,
                default: projectRoot,
            },
        },
    };
}
function resolveRuntimeRoot() {
    return path.resolve(fileURLToPath(new URL('..', import.meta.url)));
}
function findPackageRoot(startDir) {
    let current = startDir;
    while (true) {
        const candidate = path.join(current, 'package.json');
        if (fs.existsSync(candidate)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Could not locate package.json from ${startDir}`);
        }
        current = parent;
    }
}
function readPackageMetadata(packageRoot) {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
}
function resolveRuntimeDependencies(packageRoot) {
    const metadata = readPackageMetadata(packageRoot);
    return Object.keys(metadata.dependencies ?? {});
}
function packClaudeDesktopExtension(workspaceDir, outputFile) {
    fs.rmSync(outputFile, { force: true });
    const pythonCommand = resolveAvailableCommand(process.platform === 'win32'
        ? ['python', 'py', 'python3']
        : ['python3', 'python', 'py']);
    if (pythonCommand) {
        const script = [
            'import os, sys, zipfile',
            'src, dest = sys.argv[1], sys.argv[2]',
            'with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:',
            '  for root, _, files in os.walk(src):',
            '    for name in files:',
            '      full = os.path.join(root, name)',
            '      rel = os.path.relpath(full, src)',
            '      zf.write(full, rel)',
        ].join('; ');
        const result = spawnSync(pythonCommand, ['-c', script, workspaceDir, outputFile], {
            encoding: 'utf-8',
        });
        if (result.status === 0) {
            return true;
        }
    }
    if (process.platform === 'win32') {
        const shell = resolveAvailableCommand(['pwsh', 'powershell']);
        if (!shell) {
            throw new Error('Could not find Python or PowerShell to create the Claude Desktop .mcpb archive.');
        }
        const command = `Compress-Archive -Path (Join-Path '${escapePowerShellPath(workspaceDir)}' '*') -DestinationPath '${escapePowerShellPath(outputFile)}' -Force`;
        const result = spawnSync(shell, ['-NoProfile', '-Command', command], {
            encoding: 'utf-8',
        });
        if (result.status === 0) {
            return true;
        }
    }
    const zipCommand = resolveAvailableCommand(['zip']);
    if (zipCommand) {
        const result = spawnSync(zipCommand, ['-qr', outputFile, '.'], {
            cwd: workspaceDir,
            encoding: 'utf-8',
        });
        if (result.status === 0) {
            return true;
        }
    }
    throw new Error('Failed to create a .mcpb archive. Install Python 3, PowerShell, or zip.');
}
function resolveAvailableCommand(candidates) {
    for (const candidate of candidates) {
        const result = spawnSync(candidate, ['--version'], { encoding: 'utf-8' });
        if (result.status === 0) {
            return candidate;
        }
    }
    return undefined;
}
function escapePowerShellPath(value) {
    return value.replace(/'/g, "''");
}
export function renderClaudeDesktopExtensionSummary(result) {
    const lines = [
        'Claude Desktop extension scaffold ready.',
        `Workspace: ${path.relative(process.cwd(), result.workspaceDir) || result.workspaceDir}`,
        `Manifest: ${path.relative(process.cwd(), result.manifestPath) || result.manifestPath}`,
        `Server entry: ${path.relative(process.cwd(), result.entryPointPath) || result.entryPointPath}`,
    ];
    if (result.packed) {
        lines.push(`Package: ${path.relative(process.cwd(), result.outputFile) || result.outputFile}`);
        lines.push('Install in Claude Desktop via Developer -> Extensions -> Install Extension.');
    }
    else {
        lines.push('Archive packing skipped (--no-pack).');
    }
    return lines.join('\n');
}
//# sourceMappingURL=claude-desktop-extension.js.map