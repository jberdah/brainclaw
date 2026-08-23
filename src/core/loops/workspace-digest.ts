import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function fallbackFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.brainclaw' || entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...fallbackFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files;
}

/** Hash the exact tracked/untracked workspace bytes at a gate boundary. */
export function captureWorkspaceDigest(cwd: string): string {
  const rootResult = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', shell: false, maxBuffer: 1024 * 1024,
  });
  const gitRoot = rootResult.status === 0 ? rootResult.stdout.trim() : undefined;
  let files: string[];
  let root: string;
  if (gitRoot) {
    root = path.resolve(gitRoot);
    const listed = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      encoding: 'buffer', shell: false, maxBuffer: 32 * 1024 * 1024,
    });
    files = listed.status === 0
      ? listed.stdout.toString('utf8').split('\0').filter(Boolean)
      : fallbackFiles(root);
  } else {
    root = path.resolve(cwd);
    files = fallbackFiles(root);
  }
  const hash = crypto.createHash('sha256').update(root.normalize('NFC'));
  for (const relative of [...new Set(files)].sort()) {
    const absolute = path.resolve(root, relative);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile()) continue;
      hash.update('\0').update(relative.normalize('NFC')).update('\0').update(fs.readFileSync(absolute));
    } catch {
      hash.update('\0missing\0').update(relative.normalize('NFC'));
    }
  }
  return hash.digest('hex');
}
