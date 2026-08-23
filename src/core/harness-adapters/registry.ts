import { ClaudeHarnessAdapter } from './claude.js';
import { CodexHarnessAdapter } from './codex.js';
import { PromptOnlyHarnessAdapter } from './prompt-only.js';
import type { InvokeMode } from '../agent-capability.js';
import type { CapabilitySnapshot, ExecutionContract } from '../execution-contract.js';
import type { HarnessAdapter, HarnessBinding, HarnessPrepareInput, HarnessPreparedInvocation, HarnessProbeOptions } from './types.js';

const promptOnly = new PromptOnlyHarnessAdapter();
const nativeAdapters: HarnessAdapter[] = [new CodexHarnessAdapter(), new ClaudeHarnessAdapter()];

export function nativeHarnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BRAINCLAW_NATIVE_HARNESS === '1';
}

export function selectHarnessAdapter(agent: string, native = nativeHarnessEnabled()): HarnessAdapter {
  if (!native) return promptOnly;
  return nativeAdapters.find((adapter) => adapter.matches(agent)) ?? promptOnly;
}

export function resolveHarnessBinding(
  agent: string,
  requestedModel?: string,
  native?: boolean,
  probeOptions?: HarnessProbeOptions,
): HarnessBinding {
  return selectHarnessAdapter(agent, native).resolve(agent, requestedModel, probeOptions);
}

export function prepareHarnessInvocation(input: Omit<HarnessPrepareInput, 'binding'> & { binding?: HarnessBinding; native?: boolean }): HarnessPreparedInvocation {
  const binding = input.binding ?? resolveHarnessBinding(input.capability_snapshot?.agent ?? '', input.capability_snapshot?.requested.model, input.native);
  const adapter = selectHarnessAdapter(binding.agent, input.native ?? binding.adapter_id !== 'prompt-only');
  if (adapter.id !== binding.adapter_id || adapter.version !== binding.adapter_version) {
    throw new Error(`harness_binding_mismatch: frozen ${binding.adapter_id}@${binding.adapter_version}, selected ${adapter.id}@${adapter.version}`);
  }
  return adapter.prepare({ ...input, binding });
}

export function buildHarnessInvocation(
  agent: string,
  prompt: string,
  options: {
    mode?: InvokeMode;
    model?: string;
    platform?: NodeJS.Platform;
    native?: boolean;
    binding?: HarnessBinding;
    contract?: ExecutionContract;
    capability_snapshot?: CapabilitySnapshot;
  } = {},
): HarnessPreparedInvocation | undefined {
  let binding: HarnessBinding;
  try {
    binding = options.binding ?? resolveHarnessBinding(agent, options.model, options.native);
  } catch (error) {
    if (error instanceof Error && / is unavailable for /.test(error.message)) return undefined;
    throw error;
  }
  return prepareHarnessInvocation({
    binding,
    prompt,
    mode: options.mode ?? 'worker',
    platform: options.platform,
    native: options.native,
    contract: options.contract,
    capability_snapshot: options.capability_snapshot,
  });
}

export function listHarnessAdapters(): HarnessAdapter[] {
  return [promptOnly, ...nativeAdapters];
}
