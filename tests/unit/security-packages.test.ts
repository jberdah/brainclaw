import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePackageSpec, parseListEntry, matchesEntry, matchesAnyEntry } from '../../src/core/security-packages.js';

describe('security-packages', () => {
  describe('parsePackageSpec', () => {
    it('parses bare package name', () => {
      assert.deepEqual(parsePackageSpec('axios'), { depname: 'axios', version: 'latest' });
    });

    it('parses pkg@version', () => {
      assert.deepEqual(parsePackageSpec('axios@1.14.1'), { depname: 'axios', version: '1.14.1' });
    });

    it('parses scoped npm package', () => {
      assert.deepEqual(parsePackageSpec('@scope/pkg'), { depname: '@scope/pkg', version: 'latest' });
    });

    it('parses scoped npm package with version', () => {
      assert.deepEqual(parsePackageSpec('@scope/pkg@2.0.0'), { depname: '@scope/pkg', version: '2.0.0' });
    });

    it('parses pip-style pkg==version', () => {
      assert.deepEqual(parsePackageSpec('requests==2.31.0'), { depname: 'requests', version: '2.31.0' });
    });
  });

  describe('parseListEntry', () => {
    it('parses bare name with no ecosystem', () => {
      const e = parseListEntry('lodash');
      assert.equal(e.ecosystem, null);
      assert.equal(e.name, 'lodash');
      assert.equal(e.version, null);
    });

    it('parses ecosystem:name', () => {
      const e = parseListEntry('npm:lodash');
      assert.equal(e.ecosystem, 'npm');
      assert.equal(e.name, 'lodash');
      assert.equal(e.version, null);
    });

    it('parses ecosystem:name@version', () => {
      const e = parseListEntry('npm:axios@1.14.1');
      assert.equal(e.ecosystem, 'npm');
      assert.equal(e.name, 'axios');
      assert.equal(e.version, '1.14.1');
    });

    it('parses pypi:name==version', () => {
      const e = parseListEntry('pypi:requests==2.31.0');
      assert.equal(e.ecosystem, 'pypi');
      assert.equal(e.name, 'requests');
      assert.equal(e.version, '2.31.0');
    });

    it('parses scoped npm packages with ecosystem prefix', () => {
      const e = parseListEntry('npm:@scope/pkg@1.0.0');
      assert.equal(e.ecosystem, 'npm');
      assert.equal(e.name, '@scope/pkg');
      assert.equal(e.version, '1.0.0');
    });
  });

  describe('matchesEntry / matchesAnyEntry', () => {
    it('exact name match across any ecosystem when ecosystem is null', () => {
      const e = parseListEntry('lodash');
      assert.ok(matchesEntry(e, 'npm', 'lodash', '4.17.21'));
      assert.ok(matchesEntry(e, 'pypi', 'lodash', '1.0.0')); // unusual but allowed
    });

    it('does NOT match by substring (the MVP bug)', () => {
      const e = parseListEntry('lodash');
      // previous impl matched 'lodash-foo' because purl.includes('lodash')
      assert.equal(matchesEntry(e, 'npm', 'lodash-foo', '1.0.0'), false);
      assert.equal(matchesEntry(e, 'npm', 'react-lodash', '1.0.0'), false);
    });

    it('ecosystem-scoped entry does not match other ecosystem', () => {
      const e = parseListEntry('npm:requests');
      assert.ok(matchesEntry(e, 'npm', 'requests', '1.0.0'));
      assert.equal(matchesEntry(e, 'pypi', 'requests', '2.31.0'), false);
    });

    it('version-pinned entry matches exact version only', () => {
      const e = parseListEntry('npm:axios@1.14.1');
      assert.ok(matchesEntry(e, 'npm', 'axios', '1.14.1'));
      assert.equal(matchesEntry(e, 'npm', 'axios', '1.14.0'), false);
      assert.equal(matchesEntry(e, 'npm', 'axios', '1.14.2'), false);
    });

    it('* wildcard matches any version', () => {
      const e = parseListEntry('npm:axios@*');
      assert.ok(matchesEntry(e, 'npm', 'axios', '1.14.1'));
      assert.ok(matchesEntry(e, 'npm', 'axios', '2.0.0'));
      assert.equal(matchesEntry(e, 'npm', 'lodash', '1.0.0'), false);
    });

    it('matchesAnyEntry returns the first hit', () => {
      const entries = ['lodash', 'npm:axios@1.14.1'].map(parseListEntry);
      const hit = matchesAnyEntry(entries, 'npm', 'axios', '1.14.1');
      assert.ok(hit);
      assert.equal(hit?.raw, 'npm:axios@1.14.1');
    });

    it('matchesAnyEntry returns null when nothing matches', () => {
      const entries = ['npm:axios@1.14.1', 'npm:react'].map(parseListEntry);
      assert.equal(matchesAnyEntry(entries, 'npm', 'axios', '1.14.0'), null);
    });
  });
});
