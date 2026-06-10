import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { appendEvent, readUnseenEvents } from '../../src/core/event-log.js';
import { ackMessage, sendMessage } from '../../src/core/messaging.js';
import { openLoop } from '../../src/core/loops/store.js';
import { complete_turn, turn } from '../../src/core/loops/verbs.js';

// pln#562 step 4 — consumable state is keyed by INSTANCE (session/claim),
// not by agent name.
describe('instance-keyed consumable state (pln#562 step 4)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-instance-key-' });
    delete process.env.BRAINCLAW_SESSION_ID;
    delete process.env.BRAINCLAW_CLAIM_ID;
  });

  afterEach(() => {
    workspace.cleanup();
  });

  describe('event-log cursors', () => {
    it('two sessions of the same agent track independent cursors', () => {
      appendEvent({ action: 'create', item_type: 'decision', agent: 'other-agent' }, workspace.dir);

      const a = readUnseenEvents({ agent: 'codex', session_id: 'sess_a' }, workspace.dir);
      assert.equal(a.length, 1, 'instance A sees the event');

      const b = readUnseenEvents({ agent: 'codex', session_id: 'sess_b' }, workspace.dir);
      assert.equal(b.length, 1, 'instance B has its OWN cursor and also sees the event');

      const aAgain = readUnseenEvents({ agent: 'codex', session_id: 'sess_a' }, workspace.dir);
      assert.equal(aAgain.length, 0, 'instance A cursor advanced');

      const cursorsDir = path.join(workspace.dir, '.brainclaw', '.cursors');
      assert.ok(fs.existsSync(path.join(cursorsDir, 'sess_a.json')), 'session-keyed cursor file');
      assert.ok(fs.existsSync(path.join(cursorsDir, 'sess_b.json')), 'session-keyed cursor file');
    });

    it('migrates a legacy name-keyed cursor into the session cursor (no replay)', () => {
      appendEvent({ action: 'create', item_type: 'decision', agent: 'other-agent' }, workspace.dir);
      // Legacy reader consumes by name → name-keyed cursor at end of log.
      assert.equal(readUnseenEvents('codex', workspace.dir).length, 1);

      // New instance-aware reader seeds from the name cursor — no replay.
      const migrated = readUnseenEvents({ agent: 'codex', session_id: 'sess_mig' }, workspace.dir);
      assert.equal(migrated.length, 0, 'session cursor seeded from legacy name cursor');

      // New events flow normally afterwards.
      appendEvent({ action: 'update', item_type: 'plan', agent: 'other-agent' }, workspace.dir);
      assert.equal(readUnseenEvents({ agent: 'codex', session_id: 'sess_mig' }, workspace.dir).length, 1);
    });

    it('self-exclusion is by session when available, name otherwise', () => {
      appendEvent({ action: 'create', item_type: 'trap', agent: 'codex', session_id: 'sess_self' }, workspace.dir);
      appendEvent({ action: 'create', item_type: 'trap', agent: 'codex', session_id: 'sess_sibling' }, workspace.dir);
      appendEvent({ action: 'create', item_type: 'trap', agent: 'codex' }, workspace.dir); // legacy, no session

      const seen = readUnseenEvents({ agent: 'codex', session_id: 'sess_self' }, workspace.dir);
      assert.equal(seen.length, 1, 'sees the sibling instance event, skips own + legacy-name events');
      assert.equal(seen[0].session_id, 'sess_sibling');

      const legacyReader = readUnseenEvents('codex', workspace.dir);
      assert.equal(legacyReader.length, 0, 'string reader keeps name-based exclusion');
    });
  });

  describe('inbox ack claim scoping', () => {
    it('refuses an ack from a different claim, allows the owning claim and unbound messages', () => {
      const bound = sendMessage({
        from: 'coordinator', to: 'codex', type: 'assign',
        text: 'work item', claim_id: 'clm_owner',
      }, workspace.dir);
      const unbound = sendMessage({
        from: 'coordinator', to: 'codex', type: 'info', text: 'fyi',
      }, workspace.dir);

      assert.throws(
        () => ackMessage(bound.id, 'codex', workspace.dir, { claimId: 'clm_imposter' }),
        /bound to claim 'clm_owner'/,
      );

      const ok = ackMessage(bound.id, 'codex', workspace.dir, { claimId: 'clm_owner' });
      assert.equal(ok.status, 'acknowledged');

      const okUnbound = ackMessage(unbound.id, 'codex', workspace.dir, { claimId: 'clm_imposter' });
      assert.equal(okUnbound.status, 'acknowledged', 'unbound messages stay ackable');
    });
  });

  describe('loop slot claim binding', () => {
    it('complete_turn on a claim-bound slot requires the matching caller claim', () => {
      const loop = openLoop({
        kind: 'review',
        title: 'instance binding test',
        slots: [{ role: 'reviewer', agent: 'codex', agent_id: 'agt_reviewer' }],
        created_by: 'agt_coordinator',
      }, workspace.dir);
      const slotId = loop.slots[0].slot_id;

      // turn binds the slot to the dispatched instance's claim
      turn({ id: loop.id, slot_id: slotId, claim_id: 'clm_instance_a', actor: 'coordinator' }, workspace.dir);

      // Same agent_id but a DIFFERENT instance (different claim) → rejected
      assert.throws(
        () => complete_turn({
          id: loop.id,
          slot_id: slotId,
          outcome: 'done',
          actor: 'codex',
          caller_agent_id: 'agt_reviewer',
          caller_claim_id: 'clm_instance_b',
        }, workspace.dir),
        /unauthorized_slot_write/,
      );

      // The owning instance completes fine
      const done = complete_turn({
        id: loop.id,
        slot_id: slotId,
        outcome: 'done',
        actor: 'codex',
        caller_agent_id: 'agt_reviewer',
        caller_claim_id: 'clm_instance_a',
      }, workspace.dir);
      assert.equal(done.slots.find((s) => s.slot_id === slotId)?.status, 'done');
    });

    it('slots without claim binding keep the legacy agent_id auth', () => {
      const loop = openLoop({
        kind: 'review',
        title: 'legacy auth test',
        slots: [{ role: 'reviewer', agent: 'codex', agent_id: 'agt_reviewer' }],
        created_by: 'agt_coordinator',
      }, workspace.dir);
      const slotId = loop.slots[0].slot_id;
      turn({ id: loop.id, slot_id: slotId, actor: 'coordinator' }, workspace.dir);

      assert.throws(
        () => complete_turn({
          id: loop.id, slot_id: slotId, outcome: 'done', actor: 'intruder', caller_agent_id: 'agt_intruder',
        }, workspace.dir),
        /unauthorized_slot_write/,
      );

      const done = complete_turn({
        id: loop.id, slot_id: slotId, outcome: 'done', actor: 'codex', caller_agent_id: 'agt_reviewer',
      }, workspace.dir);
      assert.equal(done.slots.find((s) => s.slot_id === slotId)?.status, 'done');
    });
  });
});
