import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { buildInvokeCommand } from '../../src/core/agent-capability.js';
import {
  buildHarnessInvocation,
  listHarnessAdapters,
  resolveHarnessBinding,
  selectHarnessAdapter,
  normalizeHarnessClaimToLaneResult,
} from '../../src/core/harness-adapters/index.js';
import { resolveCapabilitySnapshot } from '../../src/core/execution-contract.js';
import { createAgentRun, recordRuntimeCapabilityObservation } from '../../src/core/agentruns.js';
import { createTestWorkspace } from '../helpers/workspace.js';

describe('HarnessAdapter registry and invocation contract (pln#681)', () => {
  const installedProbe = { resolveExecutable: (binary: string) => binary };
  it('keeps PromptOnly byte-compatible by default', () => {
    const legacy = buildInvokeCommand('codex', 'hello %PATH% & world', { platform: 'win32', model: 'gpt-5.6-sol' });
    const prepared = buildHarnessInvocation('codex', 'hello %PATH% & world', {
      platform: 'win32', model: 'gpt-5.6-sol', native: false,
    });
    assert.ok(legacy && prepared);
    assert.equal(prepared.adapter_id, 'prompt-only');
    assert.deepEqual(prepared.invoke, legacy);
  });

  it('selects native Codex and Claude only behind the feature flag', () => {
    assert.equal(selectHarnessAdapter('codex', false).id, 'prompt-only');
    assert.equal(selectHarnessAdapter('codex', true).id, 'codex-cli');
    assert.equal(selectHarnessAdapter('claude-code', true).id, 'claude-cli');
    assert.equal(selectHarnessAdapter('cline', true).id, 'prompt-only');
  });

  it('prepares argv-based native invocations without putting a Windows prompt in argv', () => {
    const prompt = 'run `npm test` & inspect %TEMP% ^ safely';
    const codexBinding = resolveHarnessBinding('codex', 'gpt-5.6-sol', true, installedProbe);
    const claudeBinding = resolveHarnessBinding('claude-code', 'sonnet', true, installedProbe);
    const codex = buildHarnessInvocation('codex', prompt, { platform: 'win32', native: true, binding: codexBinding });
    const claude = buildHarnessInvocation('claude-code', prompt, { platform: 'win32', native: true, binding: claudeBinding });
    assert.ok(codex && claude);
    assert.equal(codex.output_protocol, 'jsonl');
    assert.ok(codex.invoke.args.includes('--json'));
    assert.equal(codex.invoke.args.some((arg) => arg.includes('%TEMP%')), false);
    assert.equal(claude.output_protocol, 'json');
    assert.ok(claude.invoke.args.includes('--output-format'));
    assert.equal(claude.invoke.args.some((arg) => arg.includes('%TEMP%')), false);
    const posix = buildHarnessInvocation('codex', prompt, { platform: 'linux', native: true, binding: codexBinding });
    assert.ok(posix);
    assert.equal(posix.invoke.args.some((arg) => arg.includes('%TEMP%')), false);
    assert.match(posix.invoke.bashCommand, /--json/);
  });

  it('rejects an unattested Fable model before invocation/crossing', () => {
    assert.throws(
      () => resolveHarnessBinding('claude-code', 'claude-fable-5', true, installedProbe),
      /harness_capability_rejected.*not attested/,
    );
  });

  it('freezes adapter identity and refuses a restart with another adapter', () => {
    const binding = resolveHarnessBinding('codex', 'gpt-5.6-sol', true, installedProbe);
    assert.throws(
      () => buildHarnessInvocation('codex', 'task', { binding, native: false }),
      /harness_binding_mismatch/,
    );
  });
});

describe('HarnessAdapter outcome contract', () => {
  for (const adapter of listHarnessAdapters()) {
    it(`${adapter.id}: separates transport failure from result claims`, () => {
      const failed = adapter.parseOutcome({ exit_code: 7, stdout: '', stderr: 'boom' });
      assert.equal(failed.status, 'failed');
      assert.equal(failed.diagnostics.some((item) => item.kind === 'transport' && item.code === 'nonzero_exit'), true);
    });

    it(`${adapter.id}: classifies timeout, cancellation, and unknown exit without a false success`, () => {
      const timedOut = adapter.parseOutcome({ exit_code: 0, stdout: '', stderr: '', timed_out: true });
      const cancelled = adapter.parseOutcome({ exit_code: 0, stdout: '', stderr: '', cancelled: true });
      const unknown = adapter.parseOutcome({ stdout: '', stderr: '' });
      assert.equal(timedOut.status, 'failed');
      assert.equal(cancelled.status, 'failed');
      assert.notEqual(unknown.status, 'completed');
      assert.ok(timedOut.diagnostics.some((item) => item.code === 'timeout'));
      assert.ok(cancelled.diagnostics.some((item) => item.code === 'cancelled'));
      assert.ok(unknown.diagnostics.some((item) => item.code === 'unknown_exit'));
    });
  }

  it('Codex invalid JSONL is partial, never an authoritative success', () => {
    const result = selectHarnessAdapter('codex', true).parseOutcome({ exit_code: 0, stdout: 'not-json', stderr: '' });
    assert.equal(result.status, 'partial');
    assert.equal(result.diagnostics.some((item) => item.kind === 'protocol'), true);
  });

  it('requires an observed zero exit and a complete Codex terminal event', () => {
    const adapter = selectHarnessAdapter('codex', true);
    assert.equal(adapter.parseOutcome({ stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' }).status, 'partial');
    assert.equal(adapter.parseOutcome({ exit_code: 0, stdout: JSON.stringify({ type: 'turn.completed' }), stderr: '' }).status, 'partial');
    const valid = adapter.parseOutcome({
      exit_code: 0,
      stdout: [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify({ schema_version: 1, status: 'completed', summary: 'done', body: 'done' }) },
        }),
        JSON.stringify({ type: 'turn.completed' }),
      ].join('\n'),
      stderr: '',
    });
    assert.equal(valid.status, 'completed');
    assert.equal(valid.body, 'done');
    const mixed = adapter.parseOutcome({
      exit_code: 0,
      stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ schema_version: 1, status: 'completed', summary: 'done' }) } })}\nnot-json\n${JSON.stringify({ type: 'turn.completed' })}`,
      stderr: '',
    });
    assert.equal(mixed.status, 'partial');
  });

  it('Claude parses terminal JSON but emits only a claim, never evidence or a gate verdict', () => {
    const result = selectHarnessAdapter('claude-code', true).parseOutcome({
      exit_code: 0,
      stdout: JSON.stringify({
        type: 'result', subtype: 'success', is_error: false,
        result: JSON.stringify({ schema_version: 1, status: 'completed', summary: 'done', body: 'done' }),
        model: 'sonnet',
      }),
      stderr: '',
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.body, 'done');
    assert.equal(result.observed_model, 'sonnet');
    assert.equal('evidence' in result, false);
    assert.equal('gate' in result, false);
  });

  it('does not accept arbitrary valid Claude JSON as a successful terminal result', () => {
    const result = selectHarnessAdapter('claude-code', true).parseOutcome({
      exit_code: 0, stdout: JSON.stringify({ result: 'looks plausible' }), stderr: '',
    });
    assert.equal(result.status, 'partial');
  });

  it('parses an explicit review verdict but rejects missing or unknown verdict values', () => {
    const adapter = selectHarnessAdapter('codex', true);
    const event = (claim: Record<string, unknown>) => ({
      exit_code: 0,
      stdout: [
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(claim) } }),
        JSON.stringify({ type: 'turn.completed' }),
      ].join('\n'),
      stderr: '',
    });
    const approved = adapter.parseOutcome(event({
      schema_version: 1, status: 'completed', summary: 'LGTM', review_verdict: 'approve',
    }));
    assert.equal(approved.status, 'completed');
    assert.equal(approved.review_verdict, 'approve');
    const missing = adapter.parseOutcome(event({ schema_version: 1, status: 'completed', summary: 'LGTM' }));
    assert.equal(missing.status, 'completed', 'kind-specific review validation belongs to harvest/reconciliation');
    const unknown = adapter.parseOutcome(event({
      schema_version: 1, status: 'completed', summary: 'LGTM', review_verdict: 'maybe',
    }));
    assert.equal(unknown.status, 'partial');
  });

  for (const [kind, artifactType] of [
    ['review', 'verdict'], ['ideation', 'critique'], ['implementation', 'verification'],
    ['research', 'finding'], ['debug', 'diagnosis'],
  ] as const) {
    it(`normalizes ${kind} output to LaneResult without deciding a gate`, () => {
      const lane = normalizeHarnessClaimToLaneResult({
        status: 'completed', summary: `${kind} claim`, body: 'raw claim', artifact_type: artifactType,
        raw_output_refs: [], diagnostics: [],
      }, { assignment_id: `asgn_${kind}`, turn_id: `tat_${kind}`, run_id: `run_${kind}`, nonce: `nonce_${kind}` });
      assert.equal(lane.status, 'completed');
      assert.equal(lane.artifact_type, artifactType);
      assert.equal('evidence' in lane, false);
      assert.equal('gate' in lane, false);
    });
  }
});

describe('Harness binding persistence', () => {
  const installedProbe = { resolveExecutable: (binary: string) => binary };
  it('freezes requested/resolved/adapter identity in CapabilitySnapshot', () => {
    const binding = resolveHarnessBinding('codex', 'gpt-5.6-sol', true, installedProbe);
    const snapshot = resolveCapabilitySnapshot('codex', {
      roles: ['execute'], required_surfaces: ['cli_spawn'], execution_surfaces: ['cli'],
      model: 'gpt-5.6-sol', required_tools: [],
    }, undefined, binding);
    assert.equal(snapshot.accepted, true);
    assert.deepEqual(snapshot.resolved.harness, {
      adapter_id: 'codex-cli', adapter_version: '1', requested_model: 'gpt-5.6-sol',
      resolved_model: 'gpt-5.6-sol', model_resolution: 'unattested',
    });
  });

  it('stores observed separately and fences an observed-model mismatch monotonically', () => {
    const workspace = createTestWorkspace({ prefix: 'bclaw-harness-observed-' });
    try {
      const binding = resolveHarnessBinding('codex', 'gpt-5.6-sol', true, installedProbe);
      const snapshot = resolveCapabilitySnapshot('codex', {
        roles: ['execute'], required_surfaces: [], execution_surfaces: ['cli'],
        model: 'gpt-5.6-sol', required_tools: [],
      }, undefined, binding);
      const run = createAgentRun({
        assignment_id: 'asgn_harness', claim_id: 'clm_harness', agent: 'codex',
        transport: 'cli_spawn', scope: 'src', description: 'harness observation', capability_snapshot: snapshot,
        execution_contract_ref: { version: 1, hash: 'a'.repeat(64), snapshot_hash: 'b'.repeat(64), turn_id: 'tat_harness' },
      }, workspace.dir);
      const recorded = recordRuntimeCapabilityObservation(run.id, {
        contract_hash: 'a'.repeat(64), capability_snapshot_hash: 'b'.repeat(64),
        adapter_id: 'codex-cli', adapter_version: '1',
        observed_surfaces: ['cli'], observed_model: 'gpt-5.6-luna',
      }, {
        adapter_id: 'codex-cli', adapter_version: '1', transport_status: 'completed',
        protocol_status: 'valid', message: 'terminal result parsed',
      }, workspace.dir);
      assert.equal(recorded.capability_snapshot?.resolved.model, 'gpt-5.6-sol');
      assert.equal(recorded.runtime_capability_observation?.observed_model, 'gpt-5.6-luna');
      assert.match(recorded.execution_contract_anomaly?.reason ?? '', /differs from frozen resolved model/);
      assert.throws(() => recordRuntimeCapabilityObservation(run.id, {
        contract_hash: 'a'.repeat(64), capability_snapshot_hash: 'b'.repeat(64),
        adapter_id: 'codex-cli', adapter_version: '1',
        observed_surfaces: ['cli'], observed_model: 'gpt-5.6-sol',
      }, undefined, workspace.dir), /different runtime capability observation/);
    } finally {
      workspace.cleanup();
    }
  });

  it('fences wrong-attempt hashes and observed adapter identity', () => {
    const workspace = createTestWorkspace({ prefix: 'bclaw-harness-wrong-attempt-' });
    try {
      const binding = resolveHarnessBinding('codex', 'gpt-5.6-sol', true, installedProbe);
      const snapshot = resolveCapabilitySnapshot('codex', {
        roles: ['execute'], required_surfaces: [], execution_surfaces: ['cli'],
        model: 'gpt-5.6-sol', required_tools: [],
      }, undefined, binding);
      const run = createAgentRun({
        assignment_id: 'asgn_wrong', claim_id: 'clm_wrong', agent: 'codex', transport: 'cli_spawn',
        scope: 'src', description: 'wrong observation', capability_snapshot: snapshot,
        execution_contract_ref: { version: 1, hash: 'a'.repeat(64), snapshot_hash: 'b'.repeat(64), turn_id: 'tat_wrong' },
      }, workspace.dir);
      const recorded = recordRuntimeCapabilityObservation(run.id, {
        contract_hash: 'c'.repeat(64), capability_snapshot_hash: 'd'.repeat(64),
        adapter_id: 'claude-cli', adapter_version: '9', observed_surfaces: ['cli'],
      }, undefined, workspace.dir);
      assert.match(recorded.execution_contract_anomaly?.reason ?? '', /contract hash/);
      assert.match(recorded.execution_contract_anomaly?.reason ?? '', /observed adapter/);
    } finally {
      workspace.cleanup();
    }
  });
});

describe('native HarnessAdapter real CLI smoke (explicit opt-in)', () => {
  function runNative(agent: 'codex' | 'claude-code', model: string) {
    const binding = resolveHarnessBinding(agent, model, true);
    const prepared = buildHarnessInvocation(agent, 'Return a completed Brainclaw result claim whose summary is exactly OK.', {
      native: true, binding,
    });
    assert.ok(prepared);
    if (agent === 'codex') prepared.invoke.args.push('--ephemeral');
    else prepared.invoke.args.push('--no-session-persistence');
    const child = spawnSync(prepared.invoke.executable, prepared.invoke.args, {
      cwd: process.cwd(), input: prepared.invoke.promptText,
      encoding: 'utf8', timeout: 180_000, shell: process.platform === 'win32',
    });
    assert.equal(child.error, undefined, child.error?.message ?? 'native harness spawn failed');
    const outcome = selectHarnessAdapter(agent, true).parseOutcome({
      exit_code: child.status ?? undefined,
      stdout: child.stdout ?? '', stderr: child.stderr ?? '',
      timed_out: child.signal === 'SIGTERM' && child.status === null,
    });
    assert.equal(outcome.status, 'completed', JSON.stringify(outcome.diagnostics));
    assert.equal(outcome.summary, 'OK');
  }

  it('runs the installed Codex CLI through native JSONL', {
    skip: process.env.BRAINCLAW_CODEX_HARNESS_E2E !== '1'
      ? 'set BRAINCLAW_CODEX_HARNESS_E2E=1 to spend quota and run the real CLI'
      : false,
  }, () => runNative('codex', process.env.BRAINCLAW_CODEX_E2E_MODEL ?? 'gpt-5.6-sol'));

  it('runs the installed Claude CLI through native JSON', {
    skip: process.env.BRAINCLAW_CLAUDE_HARNESS_E2E !== '1'
      ? 'set BRAINCLAW_CLAUDE_HARNESS_E2E=1 to spend quota and run the real CLI'
      : false,
  }, () => runNative('claude-code', process.env.BRAINCLAW_CLAUDE_E2E_MODEL ?? 'sonnet'));
});
