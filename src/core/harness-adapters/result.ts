import type { LaneResult } from '../schema.js';
import { listHarnessAdapters } from './registry.js';
import type { HarnessResultClaim, TransportObservation } from './types.js';

export interface HarnessLaneIdentity {
  assignment_id: string;
  turn_id?: string;
  run_id?: string;
  nonce?: string;
  execution_contract_hash?: string;
  capability_snapshot_hash?: string;
}

export function parseHarnessOutcome(adapterId: string, observation: TransportObservation, adapterVersion?: string): HarnessResultClaim {
  const adapter = listHarnessAdapters().find((candidate) => candidate.id === adapterId);
  if (!adapter) throw new Error(`unknown harness adapter: ${adapterId}`);
  if (adapterVersion && adapter.version !== adapterVersion) {
    throw new Error(`harness adapter version mismatch: installed ${adapter.id}@${adapter.version}, frozen ${adapterId}@${adapterVersion}`);
  }
  return adapter.parseOutcome(observation);
}

/**
 * Convert an untrusted harness claim to the existing LaneResult ingress shape.
 * This is deliberately normalization only: reconcileTurn still validates
 * attempt identity and reducers/evidence/gates remain the authority boundary.
 */
export function normalizeHarnessClaimToLaneResult(
  claim: HarnessResultClaim,
  identity: HarnessLaneIdentity,
): LaneResult {
  const status: LaneResult['status'] = claim.status === 'completed'
    ? 'completed'
    : claim.status === 'blocked' ? 'blocked' : 'failed';
  return {
    ...identity,
    status,
    summary: claim.summary,
    body: claim.body,
    artifact_type: claim.artifact_type,
    review_verdict: claim.review_verdict,
    review_summary: claim.review_verdict ? claim.summary : undefined,
    notes: claim.diagnostics.length > 0
      ? claim.diagnostics.map((item) => `${item.kind}:${item.code}: ${item.message}`).join('\n')
      : undefined,
  };
}
