import fs from 'node:fs';

import { loadAgentRun, recordRuntimeCapabilityObservation } from '../agentruns.js';
import { loadAssignment } from '../assignments.js';
import { findReservationByAssignmentId } from '../loops/attempt-reservation.js';
import { executionContractForGeneration } from '../loops/attempt-authority.js';
import { resolveTurnGenerationChain } from '../loops/attempt-generations.js';
import { getRuntimeLogPath, readCompletionSignals, readContractAck } from '../runtime-signals.js';
import type { LaneResult } from '../schema.js';
import { normalizeHarnessClaimToLaneResult, parseHarnessOutcome } from './result.js';

export interface HarvestedHarnessObservation {
  lane: LaneResult;
  stdout_log: string;
  stderr_log: string;
}

function readLog(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * Convert terminal native-harness logs into the existing untrusted LaneResult
 * ingress. Reconciliation still owns identity checks, evidence sealing and
 * every protocol gate.
 */
export function harvestHarnessObservation(
  assignmentId: string,
  cwd: string,
  persist = true,
): HarvestedHarnessObservation | undefined {
  const assignment = loadAssignment(assignmentId, cwd);
  const reservation = findReservationByAssignmentId(assignmentId, cwd);
  const resolvedGeneration = reservation ? resolveTurnGenerationChain(cwd, reservation.turn_id) : undefined;
  const generation = resolvedGeneration && (resolvedGeneration.status === 'active' || resolvedGeneration.status === 'settled')
    ? resolvedGeneration.latest_generation
    : undefined;
  const generationContract = reservation && generation
    ? executionContractForGeneration(reservation, generation)
    : undefined;
  const ref = generationContract?.ref ?? reservation?.execution_contract_ref;
  const reservedHarness = reservation?.capability_snapshot?.resolved.harness;
  const projectedHarness = assignment?.capability_snapshot?.resolved.harness;
  if (reservedHarness && projectedHarness && JSON.stringify(reservedHarness) !== JSON.stringify(projectedHarness)) {
    throw new Error(`assignment ${assignmentId} harness binding diverges from the authoritative reservation`);
  }
  const harness = reservedHarness ?? projectedHarness;
  if (!assignment || !reservation || !ref || !harness || harness.adapter_id === 'prompt-only') return undefined;

  const signals = readCompletionSignals(cwd, assignmentId, generation?.run_id);
  const terminal = signals.completed ?? signals.failed;
  if (!terminal) return undefined;

  const stdoutLog = getRuntimeLogPath(cwd, assignmentId, 'stdout', generation?.run_id);
  const stderrLog = getRuntimeLogPath(cwd, assignmentId, 'stderr', generation?.run_id);
  const bothTerminalSignals = Boolean(signals.completed && signals.failed);
  const observation = {
    exit_code: bothTerminalSignals ? undefined : signals.completed ? 0 : 1,
    stdout: readLog(stdoutLog),
    stderr: readLog(stderrLog),
    completed_at: terminal.at,
  };
  const claim = parseHarnessOutcome(harness.adapter_id, observation, harness.adapter_version);
  claim.raw_output_refs = [stdoutLog, stderrLog];
  if (
    reservation.execution_contract?.identity.kind === 'review'
    && claim.status === 'completed'
    && !claim.review_verdict
  ) {
    claim.status = 'partial';
    claim.diagnostics.push({
      kind: 'protocol', code: 'missing_review_verdict',
      message: 'review result-claim v1 must carry review_verdict=approve|request_changes',
    });
  }
  claim.artifact_type ??= reservation.expected_artifacts.find((item) => item.completion_policy === 'required')?.loop_artifact_type
    ?? reservation.expected_artifacts[0]?.loop_artifact_type;

  const protocolDiagnostics = claim.diagnostics.filter((item) => item.kind === 'protocol');
  const protocolStatus = claim.status === 'partial'
    ? 'partial'
    : protocolDiagnostics.length > 0 ? 'invalid' : claim.body ? 'valid' : 'absent';
  const ack = readContractAck(cwd, assignmentId, generation?.run_id);
  const missingHash = '0'.repeat(64);
  const runtimeObservation = {
    contract_hash: terminal.contract_hash ?? missingHash,
    capability_snapshot_hash: terminal.capability_snapshot_hash ?? missingHash,
    adapter_id: harness.adapter_id,
    adapter_version: harness.adapter_version,
    observed_surfaces: ['cli'],
    observed_model: claim.observed_model,
    accepted_contract_hash: ack?.contract_hash,
    accepted_capability_snapshot_hash: ack?.capability_snapshot_hash,
  };
  const activeRunId = generation?.run_id ?? reservation.child_ids.run_id;
  const run = loadAgentRun(activeRunId, cwd);
  if (run && persist) {
    recordRuntimeCapabilityObservation(run.id, runtimeObservation, {
      adapter_id: harness.adapter_id,
      adapter_version: harness.adapter_version,
      transport_status: bothTerminalSignals ? 'failed' : signals.completed ? 'completed' : 'failed',
      protocol_status: protocolStatus,
      message: claim.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ') || undefined,
    }, cwd);
  }

  return {
    lane: normalizeHarnessClaimToLaneResult(claim, {
      assignment_id: assignmentId,
      turn_id: reservation.turn_id,
      run_id: activeRunId,
      nonce: terminal.nonce,
      attempt_epoch: terminal.attempt_epoch,
      workspace_digest: terminal.workspace_digest,
      execution_contract_hash: terminal.contract_hash,
      capability_snapshot_hash: terminal.capability_snapshot_hash,
    }),
    stdout_log: stdoutLog,
    stderr_log: stderrLog,
  };
}
