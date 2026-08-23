import type { InvokeCommand, InvokeMode } from '../agent-capability.js';
import type { CapabilitySnapshot, ExecutionContract } from '../execution-contract.js';
import type { TransportObservation } from '../execution-adapters.js';
export type { TransportObservation } from '../execution-adapters.js';

export type HarnessOutputProtocol = 'text' | 'json' | 'jsonl';

export interface HarnessProbe {
  adapter_id: string;
  adapter_version: string;
  agent: string;
  executable?: string;
  availability: 'declared' | 'unavailable';
  supported_output_protocols: HarnessOutputProtocol[];
  model_attestation: 'exact' | 'cli_selectable' | 'unattested';
  diagnostics: string[];
}

export interface HarnessProbeOptions {
  /** Injectable for deterministic tests; production resolves the installed executable. */
  resolveExecutable?: (binary: string) => string | undefined;
}

export interface HarnessBinding {
  adapter_id: string;
  adapter_version: string;
  agent: string;
  requested_model?: string;
  resolved_model?: string;
  model_resolution: 'exact' | 'defaulted' | 'unattested';
  probe: HarnessProbe;
}

export interface HarnessPrepareInput {
  binding: HarnessBinding;
  prompt: string;
  mode: InvokeMode;
  platform?: NodeJS.Platform;
  contract?: ExecutionContract;
  capability_snapshot?: CapabilitySnapshot;
}

export interface HarnessPreparedInvocation {
  adapter_id: string;
  adapter_version: string;
  invoke: InvokeCommand;
  output_protocol: HarnessOutputProtocol;
  requested_model?: string;
  resolved_model?: string;
}

export interface HarnessResultClaim {
  status: 'completed' | 'blocked' | 'failed' | 'partial';
  summary: string;
  body?: string;
  artifact_type?: string;
  review_verdict?: 'approve' | 'request_changes';
  observed_model?: string;
  raw_output_refs: string[];
  diagnostics: Array<{ kind: 'transport' | 'protocol'; code: string; message: string }>;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly version: string;
  matches(agent: string): boolean;
  probe(agent: string, options?: HarnessProbeOptions): HarnessProbe;
  resolve(agent: string, requestedModel?: string, options?: HarnessProbeOptions): HarnessBinding;
  prepare(input: HarnessPrepareInput): HarnessPreparedInvocation;
  parseOutcome(observation: TransportObservation): HarnessResultClaim;
}
