import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectPackages, isLocalOrUrl, parseRequirementsFile, parseLockfile } from '../../src/core/security-extract.js';

describe('security-extract', () => {
  let tmp: string;

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brainclaw-extract-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  describe('isLocalOrUrl', () => {
    it('flags relative paths', () => {
      assert.ok(isLocalOrUrl('.'));
      assert.ok(isLocalOrUrl('..'));
      assert.ok(isLocalOrUrl('./local-pkg'));
      assert.ok(isLocalOrUrl('../sibling'));
    });
    it('flags absolute paths (POSIX and Windows)', () => {
      assert.ok(isLocalOrUrl('/abs/path'));
      assert.ok(isLocalOrUrl('C:\\Users\\foo'));
      assert.ok(isLocalOrUrl('D:/dev/pkg'));
    });
    it('flags URLs and tarballs', () => {
      assert.ok(isLocalOrUrl('https://example.com/pkg.tgz'));
      assert.ok(isLocalOrUrl('git+https://github.com/foo/bar.git'));
      assert.ok(isLocalOrUrl('git@github.com:foo/bar.git'));
      assert.ok(isLocalOrUrl('pkg-1.0.0.tar.gz'));
      assert.ok(isLocalOrUrl('wheel-1.0.0-py3-none-any.whl'));
    });
    it('lets normal package names through', () => {
      assert.equal(isLocalOrUrl('axios'), false);
      assert.equal(isLocalOrUrl('@scope/pkg'), false);
      assert.equal(isLocalOrUrl('requests==2.31.0'), false);
    });
  });

  describe('parseRequirementsFile', () => {
    it('parses simple name and name==version lines', () => {
      const p = path.join(tmp, 'reqs.txt');
      fs.writeFileSync(p, 'requests\nflask==2.3.0\n');
      assert.deepEqual(parseRequirementsFile(p), ['requests', 'flask==2.3.0']);
    });

    it('skips comments and blank lines', () => {
      const p = path.join(tmp, 'reqs.txt');
      fs.writeFileSync(p, '# header\nrequests\n  \n# another\nflask\n');
      assert.deepEqual(parseRequirementsFile(p), ['requests', 'flask']);
    });

    it('strips env markers and extras', () => {
      const p = path.join(tmp, 'reqs.txt');
      fs.writeFileSync(p, 'requests[security]==2.31.0 ; python_version > "3.7"\n');
      assert.deepEqual(parseRequirementsFile(p), ['requests==2.31.0']);
    });

    it('keeps name only for range specs', () => {
      const p = path.join(tmp, 'reqs.txt');
      fs.writeFileSync(p, 'flask>=2.0\ndjango~=4.2\n');
      assert.deepEqual(parseRequirementsFile(p), ['flask', 'django']);
    });

    it('follows -r recursive includes', () => {
      const child = path.join(tmp, 'child.txt');
      fs.writeFileSync(child, 'numpy\n');
      const parent = path.join(tmp, 'parent.txt');
      fs.writeFileSync(parent, '-r child.txt\nrequests\n');
      assert.deepEqual(parseRequirementsFile(parent), ['numpy', 'requests']);
    });

    it('ignores other line options safely', () => {
      const p = path.join(tmp, 'reqs.txt');
      fs.writeFileSync(p, '--index-url https://example.com/simple\n-e .\nrequests\n');
      assert.deepEqual(parseRequirementsFile(p), ['requests']);
    });
  });

  describe('parseLockfile (npm)', () => {
    it('extracts top-level deps from package-lock v2+', () => {
      const p = path.join(tmp, 'package-lock.json');
      fs.writeFileSync(p, JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'my-app',
            dependencies: { axios: '^1.6.0' },
            devDependencies: { typescript: '5.4.0' },
          },
        },
      }));
      const out = parseLockfile(p);
      assert.deepEqual(out.sort(), ['axios', 'typescript@5.4.0']);
    });

    it('falls back to v1 top-level dependencies block', () => {
      const p = path.join(tmp, 'package-lock.json');
      fs.writeFileSync(p, JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          axios: { version: '1.6.0' },
          'left-pad': { version: '1.3.0' },
        },
      }));
      const out = parseLockfile(p);
      assert.deepEqual(out.sort(), ['axios@1.6.0', 'left-pad@1.3.0']);
    });

    it('throws on malformed JSON', () => {
      const p = path.join(tmp, 'package-lock.json');
      fs.writeFileSync(p, 'not json');
      assert.throws(() => parseLockfile(p), /Failed to parse lockfile/);
    });
  });

  describe('collectPackages', () => {
    it('dedupes across sources', () => {
      const p = path.join(tmp, 'reqs.txt');
      fs.writeFileSync(p, 'requests\nflask\n');
      const out = collectPackages({ packages: 'flask,django', requirements: p });
      assert.deepEqual(out.sort(), ['django', 'flask', 'requests']);
    });

    it('skips local paths in --packages', () => {
      const out = collectPackages({ packages: 'axios,./local,../sibling,/abs' });
      assert.deepEqual(out, ['axios']);
    });

    it('returns empty when no input provided', () => {
      assert.deepEqual(collectPackages({}), []);
    });
  });
});
