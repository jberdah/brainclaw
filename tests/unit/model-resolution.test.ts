/**
 * pln#520 step 3 — model selection decoupled from agent identity.
 *
 * `resolveModel` chain: override → lane → identity → profile default.
 * `buildInvokeCommand({ model })` injects `<model_flag> <model>` right after
 * the binary for agents that declare a `model_flag` (e.g. claude-code), so you
 * can run `claude-code --model sonnet` instead of a `claude-sonnet`
 * pseudo-identity.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveModel,
  buildInvokeCommand,
} from '../../src/core/agent-capability.js';

describe('resolveModel (pln#520 step 3)', () => {
  it('honours the chain order: override > lane > identity > default', () => {
    assert.equal(
      resolveModel('claude-code', { override: 'opus', lane: 'sonnet', identity: 'haiku' }),
      'opus',
    );
    assert.equal(
      resolveModel('claude-code', { lane: 'sonnet', identity: 'haiku' }),
      'sonnet',
    );
    assert.equal(resolveModel('claude-code', { identity: 'haiku' }), 'haiku');
  });

  it('returns undefined when nothing in the chain specifies a model', () => {
    // claude-code has no default_model → undefined (template default applies).
    assert.equal(resolveModel('claude-code', {}), undefined);
  });
});

describe('buildInvokeCommand model injection (pln#520 step 3)', () => {
  it('injects the model flag right after the binary for claude-code', () => {
    const cmd = buildInvokeCommand('claude-code', 'do the thing', {
      model: 'sonnet',
      platform: 'linux',
    });
    assert.ok(cmd, 'expected an invoke command');
    assert.equal(cmd!.executable, 'claude');
    // `--model sonnet` lands immediately after the binary, before -p.
    const idx = cmd!.args.indexOf('--model');
    assert.ok(idx >= 0, `expected --model in args, got: ${cmd!.args.join(' ')}`);
    assert.equal(cmd!.args[idx + 1], 'sonnet');
    // bashCommand quotes each token (e.g. `claude "--model" "sonnet" ...`).
    assert.ok(
      cmd!.bashCommand.includes('--model') && cmd!.bashCommand.includes('sonnet'),
      `expected model in bashCommand, got: ${cmd!.bashCommand}`,
    );
  });

  it('is a no-op when no model is supplied (template default applies)', () => {
    const cmd = buildInvokeCommand('claude-code', 'do the thing', { platform: 'linux' });
    assert.ok(cmd);
    assert.ok(!cmd!.args.includes('--model'), 'no --model when none requested');
  });

  it('does not double a model the template already pins (claude-sonnet)', () => {
    const cmd = buildInvokeCommand('claude-sonnet', 'do the thing', {
      model: 'opus',
      platform: 'linux',
    });
    assert.ok(cmd);
    // claude-sonnet bakes `--model sonnet`; injection is skipped (template wins),
    // so there is exactly one --model occurrence.
    const occurrences = cmd!.args.filter((a) => a === '--model').length;
    assert.equal(occurrences, 1, `expected a single --model, got: ${cmd!.args.join(' ')}`);
  });
});
