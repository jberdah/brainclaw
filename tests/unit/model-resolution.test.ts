/**
 * pln#520 step 3 — model selection decoupled from agent identity.
 *
 * `resolveModel` chain: override → lane → identity → profile default.
 * `buildInvokeCommand({ model })` injects `<model_flag> <model>` at the
 * profile's model argument position for agents that declare a `model_flag`, so
 * you can run `claude-code --model sonnet` instead of a `claude-sonnet`
 * pseudo-identity. Profiles with subcommands can place the flag after that
 * subcommand, e.g. `codex exec --model <model>`.
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
    // `--model sonnet` lands immediately after the binary, before -p. The
    // prompt is delivered by stdin, so it must not appear as an argv element.
    assert.deepEqual(cmd!.args.slice(0, 4), ['--model', 'sonnet', '-p', '--allowedTools']);
    assert.ok(!cmd!.args.includes('do the thing'), `stdin prompt leaked into args: ${cmd!.args.join(' ')}`);
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

  // pln#606 — model_flag rolled out to codex and github-copilot (verified
  // empirically: `codex exec -m|--model`, `copilot --model`).
  it('injects the model flag after the codex exec subcommand', () => {
    const cmd = buildInvokeCommand('codex', 'do the thing', {
      model: 'gpt-5-codex',
      platform: 'linux',
    });
    assert.ok(cmd, 'expected an invoke command');
    assert.equal(cmd!.executable, 'codex');
    assert.deepEqual(cmd!.args, [
      'exec',
      '--model',
      'gpt-5-codex',
      '-c',
      'approval_policy=never',
      '--sandbox',
      'workspace-write',
    ]);
    assert.equal(cmd!.promptDelivery, 'stdin_pipe');
    assert.ok(!cmd!.args.includes('do the thing'), `stdin prompt leaked into args: ${cmd!.args.join(' ')}`);
  });

  it('injects the model flag right after the binary for github-copilot', () => {
    const cmd = buildInvokeCommand('github-copilot', 'do the thing', {
      model: 'gpt-5.4',
      platform: 'linux',
    });
    assert.ok(cmd);
    assert.equal(cmd!.executable, 'copilot');
    assert.deepEqual(cmd!.args, [
      '--model',
      'gpt-5.4',
      '-p',
      'do the thing',
      '--allow-all',
      '--no-ask-user',
    ]);
  });

  it('is a no-op for codex when no model is supplied', () => {
    const cmd = buildInvokeCommand('codex', 'do the thing', { platform: 'linux' });
    assert.ok(cmd);
    assert.ok(!cmd!.args.includes('--model'), 'no --model when none requested');
  });

  it('is a no-op for github-copilot when no model is supplied', () => {
    const cmd = buildInvokeCommand('github-copilot', 'do the thing', { platform: 'linux' });
    assert.ok(cmd);
    assert.ok(!cmd!.args.includes('--model'), 'no --model when none requested');
  });
});
