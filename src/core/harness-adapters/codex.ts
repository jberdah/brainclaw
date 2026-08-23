import { applyTerminalResultClaim, buildProfileInvocation, declaredProbe, genericOutcome, parseJsonObject, resolveDeclaredBinding, withTerminalResultProtocol } from './base.js';
import type { HarnessAdapter, HarnessPrepareInput, HarnessProbeOptions, TransportObservation } from './types.js';

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = 'codex-cli';
  readonly version = '1';
  matches(agent: string): boolean { return agent.trim().toLowerCase() === 'codex'; }
  probe(agent: string, options?: HarnessProbeOptions) {
    return declaredProbe(this.id, this.version, agent, ['jsonl', 'text'], options, true);
  }
  resolve(agent: string, requestedModel?: string, options?: HarnessProbeOptions) {
    return resolveDeclaredBinding(this.probe(agent, options), requestedModel);
  }
  prepare(input: HarnessPrepareInput) {
    const prepared = buildProfileInvocation(withTerminalResultProtocol(input));
    prepared.invoke.args.push('--json');
    prepared.invoke.bashCommand += ' --json';
    return { ...prepared, output_protocol: 'jsonl' as const };
  }
  parseOutcome(observation: TransportObservation) {
    const base = genericOutcome(observation);
    const lines = observation.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const parsed = lines.map((line) => ({ line, value: parseJsonObject(line) }));
    const objects = parsed.map((item) => item.value).filter((item): item is Record<string, unknown> => Boolean(item));
    const invalidCount = parsed.filter((item) => !item.value).length;
    const agentMessages = objects.flatMap((event) => {
      const item = event.item;
      if (event.type !== 'item.completed' || !item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      return record.type === 'agent_message' && typeof record.text === 'string' ? [record.text] : [];
    });
    const result = agentMessages.at(-1);
    const terminalSuccess = objects.some((event) => event.type === 'turn.completed');
    const reversed = [...objects].reverse();
    const failure = reversed.find((event) => event.type === 'turn.failed')
      ?? reversed.find((event) => event.type === 'error');
    const failureMessage = typeof failure?.message === 'string'
      ? failure.message
      : failure?.error && typeof failure.error === 'object' && typeof (failure.error as Record<string, unknown>).message === 'string'
        ? (failure.error as Record<string, unknown>).message as string
        : undefined;
    if (invalidCount > 0) {
      base.diagnostics.push({ kind: 'protocol', code: 'invalid_jsonl', message: `${invalidCount} Codex output line(s) were not valid JSON objects` });
    }
    if (failure) {
      base.diagnostics.push({ kind: 'protocol', code: 'terminal_failure', message: failureMessage ?? 'Codex emitted a terminal failure event' });
      base.status = 'failed';
    } else if (base.status === 'completed' && (!terminalSuccess || !result || invalidCount > 0)) {
      base.diagnostics.push({ kind: 'protocol', code: 'missing_terminal_result', message: 'Codex did not emit a complete successful terminal result' });
      base.status = 'partial';
    }
    if (failure) return { ...base, summary: failureMessage?.slice(0, 1000) ?? base.summary };
    return applyTerminalResultClaim(base, result);
  }
}
