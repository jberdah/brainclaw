import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  signCloudBody,
  buildCloudWriteHeaders,
  resolveCloudSigningIdentity,
  AGENT_ID_HEADER,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
} from '../../src/core/federation-signing.js';
import { registerAgentIdentity, fingerprintPublicKeyPem } from '../../src/core/agent-registry.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import { createTestWorkspace } from '../helpers/workspace.js';

function makeKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * Mirror the cloud verifier (brainclaw-cloud/src/middleware/signature.ts):
 * Ed25519 over (body + timestamp), using the SPKI public key. Node's
 * crypto.verify(null, ...) and the Worker's WebCrypto verify('Ed25519', ...)
 * are interoperable (both raw RFC-8032 signatures).
 */
function cloudVerify(publicKeyPem: string, body: string, headers: Record<string, string>): boolean {
  const timestamp = headers[AGENT_TIMESTAMP_HEADER];
  const signature = Buffer.from(headers[AGENT_SIGNATURE_HEADER], 'base64');
  const publicKey = crypto.createPublicKey(publicKeyPem);
  return crypto.verify(null, Buffer.from(body + timestamp, 'utf-8'), publicKey, signature);
}

describe('federation-signing / signCloudBody', () => {
  it('produces headers a cloud-style Ed25519 verifier accepts', () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const body = JSON.stringify({ id: 'msg_1', type: 'runtime_note' });
    const headers = signCloudBody(body, { agentId: 'agt_cloud_1', privateKeyPem });

    assert.equal(headers[AGENT_ID_HEADER], 'agt_cloud_1');
    assert.ok(headers[AGENT_SIGNATURE_HEADER], 'signature header present');
    assert.ok(headers[AGENT_TIMESTAMP_HEADER], 'timestamp header present');
    assert.equal(cloudVerify(publicKeyPem, body, headers), true);
  });

  it('binds the signature to the body (tampered body fails)', () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const headers = signCloudBody('{"a":1}', { agentId: 'agt_1', privateKeyPem });
    assert.equal(cloudVerify(publicKeyPem, '{"a":2}', headers), false);
  });

  it('binds the signature to the timestamp (altered timestamp fails)', () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const body = '{"x":true}';
    const headers = signCloudBody(body, { agentId: 'agt_1', privateKeyPem });
    const tampered = { ...headers, [AGENT_TIMESTAMP_HEADER]: '2099-01-01T00:00:00.000Z' };
    assert.equal(cloudVerify(publicKeyPem, body, tampered), false);
  });

  it('uses a caller-provided timestamp verbatim', () => {
    const { privateKeyPem } = makeKeyPair();
    const ts = '2026-07-08T10:00:00.000Z';
    const headers = signCloudBody('{}', { agentId: 'agt_1', privateKeyPem, timestamp: ts });
    assert.equal(headers[AGENT_TIMESTAMP_HEADER], ts);
  });

  it('rejects a signature made by a different key', () => {
    const signer = makeKeyPair();
    const other = makeKeyPair();
    const body = '{"y":1}';
    const headers = signCloudBody(body, { agentId: 'agt_1', privateKeyPem: signer.privateKeyPem });
    assert.equal(cloudVerify(other.publicKeyPem, body, headers), false);
  });
});

/** Decode a base64 string into a fresh ArrayBuffer-backed Uint8Array (mirrors the cloud). */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Convert an SPKI PEM to DER bytes — identical to the cloud's pemToDer. */
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return base64ToBytes(b64);
}

describe('federation-signing / canonical fingerprint', () => {
  it('is invariant to trailing newline and CRLF (pln#101 whitespace pitfall)', () => {
    const { publicKeyPem } = makeKeyPair();
    const base = publicKeyPem.replace(/\r/g, '').trim();
    const fp = fingerprintPublicKeyPem(base);
    assert.equal(fp.length, 64);
    assert.equal(fingerprintPublicKeyPem(base + '\n'), fp);
    assert.equal(fingerprintPublicKeyPem(base + '\n\n'), fp);
    assert.equal(fingerprintPublicKeyPem(`${base.replace(/\n/g, '\r\n')}\r\n`), fp);
    assert.equal(fingerprintPublicKeyPem(`  ${base}  `), fp);
  });
});

describe('federation-signing / cross-stack WebCrypto interop', () => {
  // The backend verifies with WebCrypto (crypto.subtle) in the Workers runtime.
  // Prove a signature made by our Node signer passes that exact code path.
  it('a Node-signed body verifies under the backend WebCrypto path', async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const body = JSON.stringify({ id: 'msg_ws', type: 'signal' });
    const headers = signCloudBody(body, { agentId: 'agt_ws', privateKeyPem });

    const publicKey = await crypto.subtle.importKey(
      'spki',
      pemToDer(publicKeyPem),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const message = new TextEncoder().encode(body + headers[AGENT_TIMESTAMP_HEADER]);
    const signature = base64ToBytes(headers[AGENT_SIGNATURE_HEADER]);
    const ok = await crypto.subtle.verify('Ed25519', publicKey, signature, message);
    assert.equal(ok, true);
  });
});

describe('federation-signing / buildCloudWriteHeaders', () => {
  it('includes only the API key when unsigned and signing is not required', () => {
    const headers = buildCloudWriteHeaders('{}', { apiKey: 'bclaw_x' });
    assert.ok(headers);
    assert.equal(headers!['X-API-Key'], 'bclaw_x');
    assert.equal(headers!['Content-Type'], 'application/json');
    assert.equal(headers![AGENT_ID_HEADER], undefined);
  });

  it('adds verifiable signature headers when a signing identity is provided', () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const body = '{"claim":"src/foo.ts"}';
    const headers = buildCloudWriteHeaders(body, {
      apiKey: 'bclaw_x',
      signing: { cloudAgentId: 'agt_cloud', privateKeyPem },
    });
    assert.ok(headers);
    assert.equal(headers!['X-API-Key'], 'bclaw_x');
    assert.equal(headers![AGENT_ID_HEADER], 'agt_cloud');
    assert.equal(cloudVerify(publicKeyPem, body, headers!), true);
  });

  it('fails closed (undefined) when require_signed is set but no signing identity', () => {
    const headers = buildCloudWriteHeaders('{}', { apiKey: 'bclaw_x', requireSigned: true });
    assert.equal(headers, undefined);
  });

  it('signs (does not fail closed) when require_signed and a signing identity is present', () => {
    const { privateKeyPem } = makeKeyPair();
    const headers = buildCloudWriteHeaders('{}', {
      apiKey: 'bclaw_x',
      requireSigned: true,
      signing: { cloudAgentId: 'agt_cloud', privateKeyPem },
    });
    assert.ok(headers);
    assert.equal(headers![AGENT_ID_HEADER], 'agt_cloud');
  });
});

describe('federation-signing / resolveCloudSigningIdentity', () => {
  it('uses config cloud agent id for X-Agent-Id while BRAINCLAW_AGENT_ID selects the local key', () => {
    // Save every env var this test mutates and restore in finally — leaking
    // BRAINCLAW_AGENT_ID/NAME contaminates sibling tests (trap: agent-shell env).
    const saved = {
      cloudId: process.env.BRAINCLAW_CLOUD_AGENT_ID,
      agentId: process.env.BRAINCLAW_AGENT_ID,
      agentName: process.env.BRAINCLAW_AGENT_NAME,
    };
    delete process.env.BRAINCLAW_CLOUD_AGENT_ID;
    const workspace = createTestWorkspace({ prefix: 'bclaw-signing-' });
    let localKeyPath: string | undefined;
    try {
      const localIdentity = registerAgentIdentity({
        agentName: 'signer',
        kind: 'agent',
        generateFingerprint: true,
        cwd: workspace.dir,
        env: process.env,
      });
      // The signing key lands in the neutral home store, NOT the workspace —
      // track it so we can remove it and not accrue debris in ~/.brainclaw/keys.
      localKeyPath = path.join(os.homedir(), '.brainclaw', 'keys', `${localIdentity.agent_id}.ed25519.pem`);

      const config = loadConfig(workspace.dir);
      config.cloud_sync = {
        enabled: true,
        endpoint: 'https://example.invalid',
        api_key: 'test-key',
        agent_id: 'agt_cloud_remote',
        agent_name: 'signer',
        require_signed: true,
      };
      saveConfig(config, workspace.dir);
      process.env.BRAINCLAW_AGENT_ID = localIdentity.agent_id;
      process.env.BRAINCLAW_AGENT_NAME = localIdentity.agent_name;

      const resolved = resolveCloudSigningIdentity(workspace.dir);

      assert.ok(resolved);
      // X-Agent-Id comes from cloud_sync.agent_id, NOT the local BRAINCLAW_AGENT_ID.
      assert.equal(resolved.cloudAgentId, 'agt_cloud_remote');
      // The private key is resolved via the local identity id.
      assert.equal(resolved.localAgentId, localIdentity.agent_id);
    } finally {
      workspace.cleanup();
      if (localKeyPath) { try { fs.rmSync(localKeyPath, { force: true }); } catch { /* best-effort */ } }
      for (const [k, v] of Object.entries({
        BRAINCLAW_CLOUD_AGENT_ID: saved.cloudId,
        BRAINCLAW_AGENT_ID: saved.agentId,
        BRAINCLAW_AGENT_NAME: saved.agentName,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
