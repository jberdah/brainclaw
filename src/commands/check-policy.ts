import { memoryExists } from '../core/io.js';
import { checkPolicy, type PolicyCheckResult } from '../core/policy.js';

export interface CheckPolicyCommandOptions {
  scope: string;
  agent?: string;
  agentId?: string;
  action?: string;
  json?: boolean;
  cwd?: string;
}

export function runCheckPolicy(options: CheckPolicyCommandOptions): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const result = checkPolicy({
    scope: options.scope,
    agent: options.agent,
    agentId: options.agentId,
    action: options.action,
    cwd: options.cwd,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.allowed ? 0 : 1);
  }

  printResult(result, options.scope);
  process.exit(result.allowed ? 0 : 1);
}

function printResult(result: PolicyCheckResult, scope: string): void {
  const status = result.allowed ? '✔ ALLOWED' : '✘ BLOCKED';
  console.log(`\nPolicy check for scope "${scope}": ${status}\n`);

  if (result.blocks.length > 0) {
    console.log('Blocks:');
    for (const b of result.blocks) {
      console.log(`  ✘ [${b.kind}] ${b.message}`);
    }
    console.log('');
  }

  if (result.warnings.length > 0) {
    console.log('Warnings:');
    for (const w of result.warnings) {
      const idLabel = w.id ? ` (${w.id})` : '';
      console.log(`  ⚠ [${w.kind}]${idLabel} ${w.message}`);
    }
    console.log('');
  }

  if (result.blocks.length === 0 && result.warnings.length === 0) {
    console.log('  No issues found.');
    console.log('');
  }

  const ctx = result.governance_context;
  if (ctx.active_instructions.length > 0) {
    console.log(`Governance context: ${ctx.active_instructions.length} active instruction(s)`);
    for (const ins of ctx.active_instructions) {
      const layerLabel = ins.layer === 'global' ? '[global]' : `[${ins.layer}:${ins.scope ?? '*'}]`;
      console.log(`  ${layerLabel} ${ins.text.slice(0, 120)}${ins.text.length > 120 ? '…' : ''}`);
    }
    console.log('');
  }
}
