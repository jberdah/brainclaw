/**
 * pln#651 wave 1 (dec#156) — federation v2 demolition sentinel.
 *
 * Wave 1 abolishes the v1 cloud egress path entirely: no more `federation-cloud`,
 * `federation-outbox`, `federation-signing`, `cloud_sync` config field, or
 * BRAINCLAW_CLOUD_* env-var activation. This test IS the exit criterion of
 * step 2: it fails the CI the day a resurrection sneaks back in — a lingering
 * import, a re-added env-var opt-in, or a payload shape that lets a forbidden
 * field pass unchecked to disk.
 *
 * The federation-message envelope is what still travels between local projects
 * (dec#154: local cross-project sharing survives). This file also injects a
 * per-field SENTINEL through every remaining creator to prove that the
 * strict-schema envelope refuses unknown top-level keys, so wave-2 code cannot
 * regress by re-adding a leak-carrying field on the top of the message.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FederationMessageSchema,
  createFederationMessage,
  serializeMessage,
  validateMessage,
} from '../../src/core/federation-message.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC = path.join(REPO, 'src');

const DEMOLISHED_FILES = [
  'src/core/federation-cloud.ts',
  'src/core/federation-outbox.ts',
  'src/core/federation-signing.ts',
  'src/cli/register-federation.ts',
];

/** Recursively enumerate every .ts file under src/ (skips .d.ts). */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('federation v2 wave-1 — cloud egress files no longer exist', () => {
  for (const rel of DEMOLISHED_FILES) {
    it(`is deleted: ${rel}`, () => {
      const abs = path.join(REPO, rel);
      assert.equal(fs.existsSync(abs), false, `${rel} must not exist after dec#156 demolition`);
    });
  }
});

describe('federation v2 wave-1 — no src/ import references the deleted cloud path', () => {
  const forbiddenImports = [
    './federation-cloud.js',
    '../core/federation-cloud.js',
    './federation-outbox.js',
    '../core/federation-outbox.js',
    './federation-signing.js',
    '../core/federation-signing.js',
    '../cli/register-federation.js',
    './register-federation.js',
  ];
  const files = walkTs(SRC);

  for (const abs of files) {
    const content = fs.readFileSync(abs, 'utf-8');
    for (const marker of forbiddenImports) {
      it(`${path.relative(REPO, abs)} does not import ${marker}`, () => {
        assert.equal(
          content.includes(marker),
          false,
          `${path.relative(REPO, abs)} still imports ${marker} — the wave-1 demolition is incomplete`,
        );
      });
    }
  }
});

describe('federation v2 wave-1 — none of the removed symbols is exported from src/', () => {
  const forbiddenSymbols = [
    'pushSignalToCloud',
    'pullSignalsFromCloud',
    'pushBoardToCloud',
    'pushClaimToCloud',
    'isCloudSyncEnabled',
    'isCloudConfigured',
    'diagnoseCloudBridge',
    'ClaimCloudPayload',
    'maybeEnqueueClaimTransition',
    'isFederationEnqueueActive',
    'clearFederationEnablementCache',
    'listOutboxRecords',
    'reconcileOutbox',
    'archiveToSent',
    'parkRecord',
    'claimContentHash',
    'signCloudBody',
    'buildCloudWriteHeaders',
    'resolveCloudSigningIdentity',
    'CloudSyncConfigSchema',
    'CloudSyncConfig',
  ];
  const files = walkTs(SRC);

  for (const symbol of forbiddenSymbols) {
    it(`no src/ file re-declares '${symbol}' at export`, () => {
      const exportRe = new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${symbol}\\b`);
      const survivor = files.find((abs) => exportRe.test(fs.readFileSync(abs, 'utf-8')));
      assert.equal(
        survivor,
        undefined,
        `Symbol '${symbol}' resurfaced in ${survivor ? path.relative(REPO, survivor) : 'nowhere'} — wave-1 declared it removed.`,
      );
    });
  }
});

describe('federation v2 wave-1 — BRAINCLAW_CLOUD_API_KEY has no wire-side effect', () => {
  it('is not read by any src/ file (activation-by-env is off)', () => {
    const files = walkTs(SRC);
    const readers = files.filter((abs) => {
      const content = fs.readFileSync(abs, 'utf-8');
      return content.includes('BRAINCLAW_CLOUD_API_KEY');
    });
    assert.deepEqual(
      readers.map((f) => path.relative(REPO, f)),
      [],
      'BRAINCLAW_CLOUD_API_KEY must not be read anywhere in src/ after dec#156 — implicit env activation is exactly the wave-1 defect.',
    );
  });
});

describe('federation v2 wave-1 — the envelope schema rejects forbidden top-level keys', () => {
  const validEnvelope = createFederationMessage({
    version: 1,
    from: { project_name: 'p', project_path: '/tmp/p', agent_name: 'a' },
    to: { project_name: 'q', project_path: '/tmp/q' },
    type: 'runtime_note',
    payload: { text: 'ok' },
  });

  it('accepts a well-formed envelope (round-trip)', () => {
    const round = validateMessage(JSON.parse(serializeMessage(validEnvelope)));
    assert.equal(round.id, validEnvelope.id);
    assert.equal(round.type, 'runtime_note');
  });

  it('rejects a top-level extra key that could smuggle host state', () => {
    // The whole point of dec#156: a wave-2 refactor that adds worktree_path or
    // host_id at the envelope top-level must fail here, not on production.
    const tampered = { ...validEnvelope, worktree_path: '/leak' };
    assert.throws(() => FederationMessageSchema.parse(tampered), /worktree_path|Unrecognized/);
  });

  it('rejects an extra key nested inside from.*', () => {
    const tampered = { ...validEnvelope, from: { ...validEnvelope.from, host_secret: 'leak' } };
    assert.throws(() => FederationMessageSchema.parse(tampered), /host_secret|Unrecognized/);
  });

  it('rejects a legacy type value that was retired in wave-1', () => {
    const tampered = { ...validEnvelope, type: 'signal' };
    assert.throws(() => FederationMessageSchema.parse(tampered));
  });

  it('rejects a payload that is not an object (scalars/arrays smuggle unclassified data)', () => {
    const tampered = { ...validEnvelope, payload: 'raw-string-payload' };
    assert.throws(() => FederationMessageSchema.parse(tampered));
    const arrayed = { ...validEnvelope, payload: ['a', 'b'] };
    assert.throws(() => FederationMessageSchema.parse(arrayed));
  });
});

describe('federation v2 wave-1 — sentinel round-trip on every remaining message type', () => {
  const SENTINEL = 'ZZZ_WAVE1_SENTINEL_ZZZ';
  const types = ['candidate', 'handoff', 'runtime_note'] as const;

  for (const t of types) {
    it(`a valid ${t} payload preserves its declared fields on the wire (no silent drop)`, () => {
      const msg = createFederationMessage({
        version: 1,
        from: { project_name: 'p', project_path: '/tmp/p', agent_name: 'a' },
        to: { project_name: 'q', project_path: '/tmp/q' },
        type: t,
        payload: { text: SENTINEL, marker: `${t}_field` },
      });
      const wire = serializeMessage(msg);
      // The sentinel we DECLARED at the payload MUST reach the wire — otherwise
      // the strict schema is dropping declared payload contents, which would be
      // just as broken as leaking undeclared ones.
      assert.ok(wire.includes(SENTINEL), `${t}: declared payload sentinel is missing from wire`);
      // Round-trip stays deterministic.
      const round = validateMessage(JSON.parse(wire));
      assert.equal(round.type, t);
      assert.equal((round.payload as { text?: string }).text, SENTINEL);
    });
  }
});
