import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from './io.js';
import { logger } from './logger.js';
const GIT_DIR_NAME = '.git';
/**
 * Check if the memory directory has an internal git repo.
 */
export function hasMemoryRepo(cwd) {
    const gitDir = path.join(memoryDir(cwd), GIT_DIR_NAME);
    return fs.existsSync(gitDir);
}
/**
 * Initialize a git repo inside .brainclaw/ for memory versioning.
 * Idempotent — skips if already initialized.
 * Returns true if a new repo was created.
 */
export function initMemoryRepo(cwd) {
    const dir = memoryDir(cwd);
    if (!fs.existsSync(dir))
        return false;
    if (hasMemoryRepo(cwd))
        return false;
    try {
        git(dir, ['init', '--quiet']);
        // Configure the repo to avoid user identity errors on commit
        git(dir, ['config', 'user.name', 'brainclaw']);
        git(dir, ['config', 'user.email', 'brainclaw@local']);
        // Ignore temp files and locks
        const gitignore = path.join(dir, '.gitignore');
        if (!fs.existsSync(gitignore)) {
            fs.writeFileSync(gitignore, ['*.tmp', '*.lock', ''].join('\n'), 'utf-8');
        }
        // Initial commit
        git(dir, ['add', '-A']);
        git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'brainclaw: initial memory snapshot']);
        return true;
    }
    catch (err) {
        logger.debug('Failed to initialize memory git repo:', err);
        return false;
    }
}
/**
 * Commit all pending changes in the memory repo.
 * Called after write operations (saveState, saveRuntimeNote, etc.).
 *
 * No-op if:
 * - No memory repo exists
 * - No changes to commit
 *
 * Returns true if a commit was created.
 */
export function commitMemoryChange(message, cwd) {
    if (!hasMemoryRepo(cwd))
        return false;
    const dir = memoryDir(cwd);
    try {
        // Stage all changes
        git(dir, ['add', '-A']);
        // Check if there's anything to commit
        const status = git(dir, ['status', '--porcelain']);
        if (!status.trim())
            return false;
        git(dir, ['commit', '--quiet', '-m', message]);
        return true;
    }
    catch (err) {
        logger.debug('Failed to commit memory change:', err);
        return false;
    }
}
/**
 * Get the short log of recent memory commits.
 */
export function getMemoryLog(limit = 20, cwd) {
    if (!hasMemoryRepo(cwd))
        return [];
    const dir = memoryDir(cwd);
    try {
        const output = git(dir, ['log', '--oneline', `-${limit}`]);
        return output.trim().split('\n').filter(Boolean);
    }
    catch {
        return [];
    }
}
/**
 * Rollback the memory to a previous commit.
 * Returns true if successful.
 */
export function rollbackMemory(ref, cwd) {
    if (!hasMemoryRepo(cwd))
        return false;
    const dir = memoryDir(cwd);
    try {
        // Remove all tracked files, then restore from the target ref
        // This ensures files added after the ref are also removed
        git(dir, ['rm', '-rf', '--quiet', '--ignore-unmatch', '.']);
        git(dir, ['checkout', ref, '--', '.']);
        git(dir, ['clean', '-fd', '--quiet']);
        git(dir, ['add', '-A']);
        git(dir, ['commit', '--quiet', '--allow-empty', '-m', `brainclaw: rollback to ${ref}`]);
        return true;
    }
    catch (err) {
        logger.debug('Failed to rollback memory:', err);
        return false;
    }
}
/**
 * Get the current HEAD short hash.
 */
export function getMemoryHead(cwd) {
    if (!hasMemoryRepo(cwd))
        return undefined;
    try {
        return git(memoryDir(cwd), ['rev-parse', '--short', 'HEAD']).trim();
    }
    catch {
        return undefined;
    }
}
function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
//# sourceMappingURL=memory-git.js.map