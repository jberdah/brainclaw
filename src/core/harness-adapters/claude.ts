import { applyTerminalResultClaim, buildProfileInvocation, declaredProbe, genericOutcome, parseJsonObject, resolveDeclaredBinding, withTerminalResultProtocol } from './base.js';
import type { HarnessAdapter, HarnessPrepareInput, HarnessProbeOptions, TransportObservation } from './types.js';

export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly id = 'claude-cli';
  readonly version = '1';
  matches(agent: string): boolean { return ['claude-code', 'claude-sonnet'].includes(agent.trim().toLowerCase()); }
  probe(agent: string, options?: HarnessProbeOptions) {
    return declaredProbe(this.id, this.version, agent, ['json', 'text'], options, true);
  }
  resolve(agent: string, requestedModel?: string, options?: HarnessProbeOptions) {
    return resolveDeclaredBinding(this.probe(agent, options), requestedModel, (model) =>
      /fable/i.test(model) ? `Claude model '${model}' is not attested by the installed harness` : undefined,
    );
  }
  prepare(input: HarnessPrepareInput) {
    const prepared = buildProfileInvocation(withTerminalResultProtocol(input));
    prepared.invoke.args.push('--output-format', 'json');
    prepared.invoke.bashCommand += ' --output-format "json"';
    return { ...prepared, output_protocol: 'json' as const };
  }
  parseOutcome(observation: TransportObservation) {
    const base = genericOutcome(observation);
    const parsed = parseJsonObject(observation.stdout.trim());
    const terminalSuccess = parsed?.type === 'result'
      && parsed.subtype === 'success'
      && parsed.is_error === false
      && typeof parsed.result === 'string';
    const result = terminalSuccess ? parsed.result as string : undefined;
    const observedModel = typeof parsed?.model === 'string' ? parsed.model : undefined;
    if (!parsed && observation.stdout.trim()) {
      base.diagnostics.push({ kind: 'protocol', code: 'invalid_json', message: 'Claude output was not valid JSON' });
    } else if (!terminalSuccess) {
      base.diagnostics.push({ kind: 'protocol', code: 'missing_terminal_result', message: 'Claude did not emit a successful terminal result object' });
    }
    if (base.status === 'completed' && !terminalSuccess) base.status = 'partial';
    const claimed = terminalSuccess ? applyTerminalResultClaim(base, result) : base;
    return { ...claimed, observed_model: observedModel };
  }
}
