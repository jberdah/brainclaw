import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runStructuralDetectors, runEntropyDetector, shannonEntropy, maskSecret } from '../../src/core/security-detectors.js';

describe('security-detectors', () => {
  describe('runStructuralDetectors', () => {
    it('finds a GitHub PAT', () => {
      const text = 'export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      const matches = runStructuralDetectors(text);
      assert.ok(matches.some(m => m.detectorId === 'github_pat'));
    });

    it('finds an AWS access key', () => {
      const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      const matches = runStructuralDetectors(text);
      assert.ok(matches.some(m => m.detectorId === 'aws_access_key'));
    });

    it('finds a JWT', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const matches = runStructuralDetectors('token=' + jwt);
      assert.ok(matches.some(m => m.detectorId === 'jwt'));
    });

    it('finds a URL with embedded credentials', () => {
      const text = 'DATABASE_URL=postgres://admin:supersecret@db.example.com/app';
      const matches = runStructuralDetectors(text);
      assert.ok(matches.some(m => m.detectorId === 'url_basic_auth'));
    });

    it('finds a PEM private key header', () => {
      const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB...';
      const matches = runStructuralDetectors(text);
      assert.ok(matches.some(m => m.detectorId === 'pem_private_key'));
    });

    it('does not flag innocuous text', () => {
      const matches = runStructuralDetectors('Hello world, no secrets here.');
      assert.equal(matches.length, 0);
    });

    it('honors the disabled map', () => {
      const text = 'AKIAIOSFODNN7EXAMPLE';
      const matches = runStructuralDetectors(text, { aws_access_key: false });
      assert.equal(matches.length, 0);
    });

    it('never leaks the full secret in the excerpt, even for short matches', () => {
      // Short realistic secrets that the old 48-char truncation returned verbatim.
      const secrets = [
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',   // 40-char GitHub PAT
        // Stripe-shaped fixture is joined at runtime so no contiguous literal
        // exists in this file (GitHub push protection scans raw blobs).
        ['sk_test', 'aB3xZ9qP4mR6tBw5cZ7hF1xK'].join('_'), // 32-char Stripe key (shortest form)
        'AKIAIOSFODNN7EXAMPLE',                        // 20-char AWS access key ID
      ];
      for (const secret of secrets) {
        const m = runStructuralDetectors(secret)[0];
        assert.ok(m, `detector should fire for ${secret.slice(0, 4)}…`);
        assert.ok(!m.excerpt.includes(secret), `excerpt must not contain the full secret (${m.detectorId})`);
        assert.ok(!secret.includes(m.excerpt), `excerpt must not be a recoverable substring of the secret (${m.detectorId})`);
      }
    });

    it('keeps an identifying prefix so the operator can recognize the token family', () => {
      const secrets = [
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        ['sk_test', 'aB3xZ9qP4mR6tBw5cZ7hF1xK'].join('_'),
        'AKIAIOSFODNN7EXAMPLE',
      ];
      for (const secret of secrets) {
        const m = runStructuralDetectors(secret)[0];
        assert.ok(m);
        assert.ok(m.excerpt.startsWith(secret.slice(0, 4)), `excerpt '${m.excerpt}' should start with '${secret.slice(0, 4)}'`);
      }
    });

    it('bounds the excerpt length regardless of match size', () => {
      const long = 'github_pat_' + '11AAAAAAA0'.repeat(8) + 'ab'; // 93-char fine-grained PAT
      const short = 'AKIAIOSFODNN7EXAMPLE';
      for (const secret of [long, short]) {
        const m = runStructuralDetectors(secret)[0];
        assert.ok(m);
        assert.ok(m.excerpt.length <= 50, `excerpt length ${m.excerpt.length} exceeds bound`);
        assert.ok(m.excerpt.length <= 11, `mask is fixed-width; got ${m.excerpt.length}`);
      }
    });

    it('masking does not change detectorId/label (no detection-API regression)', () => {
      const text = 'export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      const m = runStructuralDetectors(text)[0];
      assert.ok(m);
      assert.equal(m.detectorId, 'github_pat');
      assert.equal(m.label, 'GitHub personal access token');
      assert.deepEqual(Object.keys(m).sort(), ['detectorId', 'excerpt', 'label']);
    });
  });

  describe('maskSecret', () => {
    it('keeps at most 4 leading + 2 trailing chars for long matches', () => {
      assert.equal(maskSecret('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'ghp_…***…89');
      assert.equal(maskSecret('AKIAIOSFODNN7EXAMPLE'), 'AKIA…***…LE');
    });

    it('masks everything but the first char for matches of 8 chars or fewer', () => {
      assert.equal(maskSecret('password'), 'p***');
      // ≤2 code points: exposing even the first char would reveal most or all
      // of the value (re-review finding: a 1-cp configured redaction pattern
      // 'x' must not survive as 'x***').
      assert.equal(maskSecret('ab'), '***');
      assert.equal(maskSecret('x'), '***');
      assert.ok(!maskSecret('x').includes('x'));
    });

    it('returns an empty string for an empty match', () => {
      assert.equal(maskSecret(''), '');
    });

    it('output never contains more than 6 chars of the input', () => {
      const secret = ['sk_live', 'aB3xZ9qP4mR6tBw5cZ7hF1xK2eU3rI4o'].join('_');
      const masked = maskSecret(secret);
      assert.ok(!secret.includes(masked));
      assert.ok(!masked.includes(secret.slice(0, 7)), 'must not expose a 7-char prefix');
    });

    it('scales exposure smoothly across the 8/9 code-point boundary', () => {
      // 8 code points → short mode: exactly 1 code point retained.
      assert.equal(maskSecret('abcdefgh'), 'a***');
      // 9 code points → ⌊9/3⌋ = 3 exposed (2 leading + 1 trailing), not 6.
      assert.equal(maskSecret('abcdefghi'), 'ab…***…i');
      // 12 code points → ⌊12/3⌋ = 4 exposed (3 leading + 1 trailing).
      assert.equal(maskSecret('abcdefghijkl'), 'abc…***…l');
      // The 4+2 shape only unlocks at 18+ code points.
      assert.equal(maskSecret('abcdefghijklmnopqr'), 'abcd…***…qr');
    });

    it('splits by code point, never cutting surrogate pairs', () => {
      // U+20000..U+20009 — non-BMP CJK, each 2 UTF-16 units.
      const secret = '𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈𠀉'; // 10 code points, 20 UTF-16 units
      const masked = maskSecret(secret);
      assert.equal(masked, '𠀀𠀁…***…𠀉'); // ⌊10/3⌋ = 3 exposed → 2 + 1
      const unpaired = masked.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
      assert.ok(!/[\uD800-\uDFFF]/.test(unpaired), 'output must not contain lone surrogates');
      // 8 non-BMP code points (16 UTF-16 units) still take the short branch.
      assert.equal(maskSecret('🔑'.repeat(8)), '🔑***');
    });

    it('never exposes more than min(6, ⌊length/3⌋) code points of a long match', () => {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      for (const len of [9, 10, 11, 12, 15, 17, 18, 20, 30, 48, 93]) {
        const secret = Array.from({ length: len }, (_, i) => alphabet[i % alphabet.length]).join('');
        const masked = maskSecret(secret);
        const parts = masked.split('…***…');
        assert.equal(parts.length, 2, `mask marker missing for length ${len}: '${masked}'`);
        const exposedCount = Array.from(parts[0]).length + Array.from(parts[1]).length;
        const cap = Math.min(6, Math.floor(len / 3));
        assert.ok(exposedCount <= cap, `length ${len}: ${exposedCount} code points exposed, cap is ${cap}`);
        assert.ok(secret.startsWith(parts[0]) && secret.endsWith(parts[1]), 'exposed parts come from the match ends');
      }
    });
  });

  describe('shannonEntropy', () => {
    it('returns 0 for an empty string', () => {
      assert.equal(shannonEntropy(''), 0);
    });

    it('returns 0 for a constant string', () => {
      assert.equal(shannonEntropy('aaaaaa'), 0);
    });

    it('returns higher entropy for random-looking strings', () => {
      const low = shannonEntropy('aaaaaaaabbbbbbbb');
      const high = shannonEntropy('aB3$xZ9!qP2&vN7#');
      assert.ok(high > low);
    });
  });

  describe('runEntropyDetector', () => {
    it('flags a high-entropy token near a secret keyword', () => {
      // 40-char base64-ish token after "api_key" keyword.
      const text = 'api_key = "Yk9pVj3DqL8N0sP4mR6tBw5cZ7hF1xK2eU3rI4o"';
      const matches = runEntropyDetector(text, { minLength: 32, minEntropy: 4.0 });
      assert.ok(matches.length >= 1);
    });

    it('ignores a high-entropy token with no secret-keyword context', () => {
      // Same token but no keyword nearby — pure random gibberish in prose.
      const text = 'Random session id: Yk9pVj3DqL8N0sP4mR6tBw5cZ7hF1xK2eU3rI4o (debug only)';
      const matches = runEntropyDetector(text);
      assert.equal(matches.length, 0);
    });

    it('ignores plain decimal numbers even when long', () => {
      const text = 'order_id token=01234567890123456789012345678901234567890';
      const matches = runEntropyDetector(text);
      assert.equal(matches.length, 0);
    });

    it('respects min_length threshold', () => {
      const text = 'api_key=' + 'aB3xZ9qP'; // 8 chars — under threshold
      const matches = runEntropyDetector(text, { minLength: 32 });
      assert.equal(matches.length, 0);
    });

    it('returns nothing when disabled', () => {
      const text = 'api_key=Yk9pVj3DqL8N0sP4mR6tBw5cZ7hF1xK2eU3rI4o';
      const matches = runEntropyDetector(text, { enabled: false });
      assert.equal(matches.length, 0);
    });

    it('masks the excerpt but keeps the entropy value intact', () => {
      const token = 'Yk9pVj3DqL8N0sP4mR6tBw5cZ7hF1xK2eU3rI4o';
      const matches = runEntropyDetector(`api_key = "${token}"`, { minLength: 32, minEntropy: 4.0 });
      assert.ok(matches.length >= 1);
      const m = matches[0];
      assert.ok(!m.excerpt.includes(token), 'excerpt must not contain the raw token');
      assert.ok(m.excerpt.startsWith(token.slice(0, 4)), 'excerpt keeps an identifying prefix');
      assert.equal(typeof m.entropy, 'number');
      assert.ok(m.entropy >= 4.0, 'entropy field unchanged by masking');
    });
  });
});
