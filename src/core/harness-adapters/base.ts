import { buildInvokeCommand, getCapabilityProfile } from '../agent-capability.js';
import { resolveBinaryOnPath } from '../execution-adapters.js';
import { z } from 'zod';
import type {
  HarnessBinding,
  HarnessOutputProtocol,
  HarnessPrepareInput,
  HarnessPreparedInvocation,
  HarnessProbe,
  HarnessProbeOptions,
  HarnessResultClaim,
  TransportObservation,
} from './types.js';

const TerminalResultClaimSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(['completed', 'blocked', 'failed', 'partial']),
  summary: z.string().min(1),
  body: z.string().min(1).optional(),
  artifact_type: z.string().min(1).optional(),
  review_verdict: z.enum(['approve', 'request_changes']).optional(),
}).strict();

const TERMINAL_RESULT_PROTOCOL = `

Brainclaw native terminal result contract:
Your final assistant message MUST be exactly one JSON object with this shape and no markdown fence:
{"schema_version":1,"status":"completed|blocked|failed|partial","summary":"...","body":"optional details","artifact_type":"optional Loop artifact type","review_verdict":"approve|request_changes (required for review verdict work)"}
Do not infer or omit review_verdict when the task requires a review verdict.`;

export function withTerminalResultProtocol(input: HarnessPrepareInput): HarnessPrepareInput {
  return { ...input, prompt: `${input.prompt}${TERMINAL_RESULT_PROTOCOL}` };
}

export function parseTerminalResultClaim(text: string): HarnessResultClaim | undefined {
  const parsed = parseJsonObject(text.trim());
  const claim = TerminalResultClaimSchema.safeParse(parsed);
  if (!claim.success) return undefined;
  return { ...claim.data, raw_output_refs: [], diagnostics: [] };
}

export function applyTerminalResultClaim(
  base: HarnessResultClaim,
  terminalText: string | undefined,
): HarnessResultClaim {
  const structured = terminalText ? parseTerminalResultClaim(terminalText) : undefined;
  if (!structured) {
    base.diagnostics.push({
      kind: 'protocol', code: 'invalid_result_claim',
      message: 'terminal assistant output was not a strict Brainclaw result-claim v1 object',
    });
    if (base.status === 'completed') base.status = 'partial';
    return base;
  }
  if (base.status !== 'completed') {
    return {
      ...base,
      summary: structured.summary,
      body: structured.body,
      artifact_type: structured.artifact_type,
      review_verdict: structured.review_verdict,
    };
  }
  return {
    ...base,
    status: structured.status,
    summary: structured.summary,
    body: structured.body,
    artifact_type: structured.artifact_type,
    review_verdict: structured.review_verdict,
  };
}

export function declaredProbe(
  adapterId: string,
  adapterVersion: string,
  agent: string,
  protocols: HarnessOutputProtocol[],
  options: HarnessProbeOptions = {},
  requireInstalledExecutable = false,
): HarnessProbe {
  const profile = getCapabilityProfile(agent);
  const executable = profile?.invoke_binary;
  const resolvedExecutable = executable && requireInstalledExecutable
    ? (options.resolveExecutable ?? resolveBinaryOnPath)(executable)
    : executable;
  const available = Boolean(profile?.runtime.canBeSpawnedCli && executable && resolvedExecutable);
  return {
    adapter_id: adapterId,
    adapter_version: adapterVersion,
    agent,
    executable,
    availability: available ? 'declared' : 'unavailable',
    supported_output_protocols: protocols,
    model_attestation: profile?.model_flag ? 'cli_selectable' : 'unattested',
    diagnostics: !profile
      ? [`unknown agent profile: ${agent}`]
      : requireInstalledExecutable && executable && !resolvedExecutable
        ? [`executable not found on PATH: ${executable}`]
        : [],
  };
}

export function resolveDeclaredBinding(
  probe: HarnessProbe,
  requestedModel?: string,
  rejectModel?: (model: string) => string | undefined,
): HarnessBinding {
  if (probe.availability === 'unavailable') {
    throw new Error(`harness_capability_rejected: ${probe.adapter_id} is unavailable for ${probe.agent}`);
  }
  const rejection = requestedModel && rejectModel?.(requestedModel);
  if (rejection) throw new Error(`harness_capability_rejected: ${rejection}`);
  return {
    adapter_id: probe.adapter_id,
    adapter_version: probe.adapter_version,
    agent: probe.agent,
    requested_model: requestedModel,
    resolved_model: requestedModel,
    // A CLI model flag proves selection intent, not that the installed account
    // can serve that name. We pass the exact string and never configure a
    // fallback, but keep the resolution honest until runtime observes it.
    model_resolution: requestedModel ? 'unattested' : 'defaulted',
    probe,
  };
}

export function buildProfileInvocation(input: HarnessPrepareInput): HarnessPreparedInvocation {
  const invoke = buildInvokeCommand(input.binding.agent, input.prompt, {
    mode: input.mode,
    platform: input.platform,
    model: input.binding.resolved_model,
  });
  if (!invoke) throw new Error(`harness_prepare_failed: no invoke command for ${input.binding.agent}`);
  return {
    adapter_id: input.binding.adapter_id,
    adapter_version: input.binding.adapter_version,
    invoke,
    output_protocol: 'text',
    requested_model: input.binding.requested_model,
    resolved_model: input.binding.resolved_model,
  };
}

export function genericOutcome(observation: TransportObservation): HarnessResultClaim {
  const diagnostics: HarnessResultClaim['diagnostics'] = [];
  if (observation.timed_out) diagnostics.push({ kind: 'transport', code: 'timeout', message: 'execution timed out' });
  if (observation.cancelled) diagnostics.push({ kind: 'transport', code: 'cancelled', message: 'execution was cancelled' });
  if (observation.exit_code === undefined) {
    diagnostics.push({ kind: 'transport', code: 'unknown_exit', message: 'process exit code was not observed' });
  } else if (observation.exit_code !== 0) {
    diagnostics.push({ kind: 'transport', code: 'nonzero_exit', message: `process exited with ${observation.exit_code}` });
  }
  const text = observation.stdout.trim() || observation.stderr.trim();
  return {
    status: observation.timed_out || observation.cancelled || (observation.exit_code !== undefined && observation.exit_code !== 0)
      ? 'failed'
      : observation.exit_code === 0 ? 'completed' : 'partial',
    summary: text.slice(0, 1000) || 'harness completed without terminal text',
    body: text || undefined,
    raw_output_refs: [],
    diagnostics,
  };
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
