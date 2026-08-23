import { buildProfileInvocation, declaredProbe, genericOutcome, resolveDeclaredBinding } from './base.js';
import type { HarnessAdapter, HarnessProbeOptions } from './types.js';

export class PromptOnlyHarnessAdapter implements HarnessAdapter {
  readonly id = 'prompt-only';
  readonly version = '1';
  matches(): boolean { return true; }
  probe(agent: string, options?: HarnessProbeOptions) { return declaredProbe(this.id, this.version, agent, ['text'], options); }
  resolve(agent: string, requestedModel?: string, options?: HarnessProbeOptions) {
    return resolveDeclaredBinding(this.probe(agent, options), requestedModel);
  }
  prepare = buildProfileInvocation;
  parseOutcome = genericOutcome;
}
