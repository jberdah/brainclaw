import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runStructuralDetectors, runEntropyDetector, shannonEntropy } from '../../src/core/security-detectors.js';

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

    it('truncates the excerpt to avoid leaking the full secret in logs', () => {
      const pat = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      const m = runStructuralDetectors(pat)[0];
      assert.ok(m);
      assert.ok(m.excerpt.length <= 50);
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
  });
});
