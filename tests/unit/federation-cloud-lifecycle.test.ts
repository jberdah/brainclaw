/**
 * Federation Phase 1 finalization tests (pln#365 follow-up of REVIEW_FINDINGS).
 *
 * Covers the end-to-end cloud_sync lifecycle that the prior federation-cloud
 * tests stub at the HTTP layer only:
 *   - `pushSessionCloudSignals` visibility gate: which entity types actually
 *     leave the machine when cloud_sync is opted-in.
 *   - 2-session simulation: session A pushes signals to cloud (mocked), session B
 *     pulls them and materializes them into its own store.
 *
 * The fetch boundary is mocked. There is no real cloud running.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { startSession } from '../../src/commands/session-start.js';
import { endSession } from '../../src/commands/session-end.js';
import { saveRuntimeNote, generateRuntimeNoteId, listRuntimeNotes } from '../../src/core/runtime.js';
import { saveState, loadState } from '../../src/core/state.js';
import { listCandidates } from '../../src/core/candidates.js';
import { createFederationMessage, type FederationMessage } from '../../src/core/federation-message.js';
import { generateId, nowISO, generateIdWithLabel } from '../../src/core/ids.js';

interface CapturedFetchCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(responder: (call: CapturedFetchCall) => Response): {
  calls: CapturedFetchCall[];
  restore: () => void;
} {
  const calls: CapturedFetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown = undefined;
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call: CapturedFetchCall = { url, method: init?.method ?? 'GET', body };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function clearCloudEnv(): { restore: () => void } {
  const saved = {
    key: process.env.BRAINCLAW_CLOUD_API_KEY,
    url: process.env.BRAINCLAW_CLOUD_URL,
  };
  delete process.env.BRAINCLAW_CLOUD_API_KEY;
  delete process.env.BRAINCLAW_CLOUD_URL;
  return {
    restore: () => {
      if (saved.key === undefined) delete process.env.BRAINCLAW_CLOUD_API_KEY;
      else process.env.BRAINCLAW_CLOUD_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.BRAINCLAW_CLOUD_URL;
      else process.env.BRAINCLAW_CLOUD_URL = saved.url;
    },
  };
}

/** Seed a session's runtime_note with the given visibility. */
function seedRuntimeNote(
  workspace: TestWorkspace,
  sessionId: string,
  visibility: 'shared' | 'machine' | 'private' | undefined,
  text: string,
): void {
  saveRuntimeNote({
    id: generateRuntimeNoteId(),
    agent: workspace.currentAgent.agent_name,
    agent_id: workspace.currentAgent.agent_id,
    project_id: 'prj_test',
    session_id: sessionId,
    text,
    created_at: nowISO(),
    tags: ['federation-test'],
    visibility: visibility ?? 'shared',
    note_type: 'observation',
  }, workspace.dir);
}

/** Seed an open_handoff with the given visibility. */
function seedHandoff(
  workspace: TestWorkspace,
  sessionId: string,
  visibility: 'shared' | 'machine' | 'private' | undefined,
  text: string,
): void {
  const state = loadState(workspace.dir);
  const { id, short_label } = generateIdWithLabel('open_handoffs', workspace.dir);
  state.open_handoffs.push({
    id,
    short_label,
    from: workspace.currentAgent.agent_name,
    to: 'reviewer',
    text,
    created_at: nowISO(),
    author: workspace.currentAgent.agent_name,
    session_id: sessionId,
    status: 'open',
    tags: ['federation-test'],
    ...(visibility ? { visibility } : {}),
  });
  saveState(state, workspace.dir);
}

describe('federation-cloud lifecycle — pushSessionCloudSignals visibility gate', () => {
  let workspace: TestWorkspace;
  let envReset: { restore: () => void };
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    envReset = clearCloudEnv();
    workspace = createTestWorkspace({ prefix: 'bclaw-fed-lifecycle-' });
    // Opt-in cloud_sync via env var (implicit enabled per resolveCloudConfig).
    process.env.BRAINCLAW_CLOUD_API_KEY = 'test-key';
    process.env.BRAINCLAW_CLOUD_URL = 'https://example.invalid';
    // Default mock: 200 OK to all calls.
    fetchMock = installFetchMock(() => new Response('{"messages":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });

  afterEach(() => {
    fetchMock.restore();
    envReset.restore();
    workspace.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
  });

  /**
   * Note: session-start/session-end emit their own auto-generated runtime_notes
   * with `note_type: 'session_start' | 'session_end'` and `visibility: 'shared'`
   * by default. Those legitimately get pushed too. The assertions below filter
   * by the unique TEXT of the seeded note to count only the entity under test.
   */
  function pushedTexts(calls: CapturedFetchCall[]): string[] {
    return calls
      .filter((c) => c.method === 'POST' && c.url.includes('/api/v1/messages'))
      .map((c) => (c.body as FederationMessage).payload as { text?: string })
      .map((p) => p.text ?? '');
  }

  it('pushes runtime_note with visibility="shared" to cloud', async () => {
    const sessionId = 'sess_visibility_shared_rtn';
    process.env.BRAINCLAW_SESSION_ID = sessionId;
    await startSession({ cwd: workspace.dir });
    seedRuntimeNote(workspace, sessionId, 'shared', 'TEST-shared-rtn-marker');

    await endSession({ session: sessionId, cwd: workspace.dir });

    const texts = pushedTexts(fetchMock.calls);
    assert.ok(texts.includes('TEST-shared-rtn-marker'),
      `expected the seeded shared note to be pushed, got texts: ${JSON.stringify(texts)}`);
    delete process.env.BRAINCLAW_SESSION_ID;
  });

  it('SKIPS runtime_note with visibility="machine"', async () => {
    const sessionId = 'sess_visibility_machine_rtn';
    process.env.BRAINCLAW_SESSION_ID = sessionId;
    await startSession({ cwd: workspace.dir });
    seedRuntimeNote(workspace, sessionId, 'machine', 'TEST-machine-rtn-marker');

    await endSession({ session: sessionId, cwd: workspace.dir });

    const texts = pushedTexts(fetchMock.calls);
    assert.ok(!texts.includes('TEST-machine-rtn-marker'),
      `machine-visibility note must NOT be pushed; saw texts: ${JSON.stringify(texts)}`);
    delete process.env.BRAINCLAW_SESSION_ID;
  });

  it('pushes handoff ONLY when visibility="shared" is set explicitly', async () => {
    const sessionId = 'sess_visibility_handoff';
    process.env.BRAINCLAW_SESSION_ID = sessionId;
    await startSession({ cwd: workspace.dir });
    seedHandoff(workspace, sessionId, 'shared', 'opt-in handoff');
    seedHandoff(workspace, sessionId, undefined, 'opt-out handoff (no visibility field)');
    seedHandoff(workspace, sessionId, 'private', 'private handoff');

    await endSession({ session: sessionId, cwd: workspace.dir });

    const pushCalls = fetchMock.calls.filter((c) => c.method === 'POST' && c.url.includes('/api/v1/messages'));
    const handoffPushes = pushCalls.filter((c) => (c.body as FederationMessage).type === 'handoff');
    assert.equal(handoffPushes.length, 1, `expected exactly 1 handoff push (the shared one), got ${handoffPushes.length}`);
    const payload = (handoffPushes[0].body as FederationMessage).payload as { text?: string };
    assert.equal(payload.text, 'opt-in handoff');
    delete process.env.BRAINCLAW_SESSION_ID;
  });

  it('no push at all when cloud_sync is not enabled', async () => {
    delete process.env.BRAINCLAW_CLOUD_API_KEY; // disable cloud
    const sessionId = 'sess_no_optin';
    process.env.BRAINCLAW_SESSION_ID = sessionId;
    await startSession({ cwd: workspace.dir });
    seedRuntimeNote(workspace, sessionId, 'shared', 'shared but cloud is off');
    seedHandoff(workspace, sessionId, 'shared', 'shared handoff but cloud is off');

    await endSession({ session: sessionId, cwd: workspace.dir });

    const pushCalls = fetchMock.calls.filter((c) => c.method === 'POST' && c.url.includes('/api/v1/messages'));
    assert.equal(pushCalls.length, 0, 'cloud must not be hit when opt-in is absent');
    delete process.env.BRAINCLAW_SESSION_ID;
  });
});

describe('federation-cloud lifecycle — 2-session push/pull roundtrip (mocked cloud)', () => {
  let workspace: TestWorkspace;
  let envReset: { restore: () => void };
  /** "Cloud" state shared between push and pull calls within one test. */
  let mockInbox: FederationMessage[];

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    envReset = clearCloudEnv();
    workspace = createTestWorkspace({ prefix: 'bclaw-fed-e2e-' });
    process.env.BRAINCLAW_CLOUD_API_KEY = 'test-key';
    process.env.BRAINCLAW_CLOUD_URL = 'https://example.invalid';
    mockInbox = [];
  });

  afterEach(() => {
    envReset.restore();
    workspace.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
    delete process.env.BRAINCLAW_SESSION_ID;
  });

  it('session A pushes a runtime_note; session B pulls + materializes it', async () => {
    // Mock fetch: POST writes to mockInbox; GET drains it as the agent's inbox.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.includes('/api/v1/messages')) {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        if (body) mockInbox.push(body as FederationMessage);
        return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'GET' && url.includes('/api/v1/inbox/')) {
        const messages = mockInbox.slice();
        mockInbox = []; // simulate cloud-side "marked as delivered"
        return new Response(JSON.stringify({ messages }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      // ── Session A: write a shared runtime_note + push at session_end
      const sessionA = 'sess_e2e_a';
      process.env.BRAINCLAW_SESSION_ID = sessionA;
      await startSession({ cwd: workspace.dir });
      seedRuntimeNote(workspace, sessionA, 'shared', 'message from session A to the future');
      await endSession({ session: sessionA, cwd: workspace.dir });

      const seededPush = mockInbox.find(
        (m) => m.type === 'runtime_note' && (m.payload as { text?: string }).text === 'message from session A to the future',
      );
      assert.ok(seededPush, `cloud should have received the seeded push; inbox had ${mockInbox.length} items`);

      // ── Session B: pull at session_start should materialize the inbox entry
      // In a real cross-machine scenario this would be a different workspace.
      // For this test we simulate it by starting a new session within the
      // same workspace — the pull/materialize path doesn't care about
      // workspace identity, only about cloud responses.
      const sessionB = 'sess_e2e_b';
      process.env.BRAINCLAW_SESSION_ID = sessionB;
      await startSession({ cwd: workspace.dir, maintenanceMode: 'full' });

      // The materialized runtime_note should now live in the local store.
      const notes = listRuntimeNotes(undefined, workspace.dir);
      const materialized = notes.find(
        (n) => n.text === 'message from session A to the future'
          && (n.tags ?? []).some((t) => t.startsWith('remote:')),
      );
      assert.ok(materialized, `expected a materialized runtime_note with a remote: origin tag, got ${notes.length} notes total`);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// Keep generateId in the import list for future tests.
void generateId;
void fs;
void path;
