/**
 * CLI command: brainclaw run <profile-name>
 *
 * Loads an agent profile, resolves the invoke template, and spawns the agent.
 *
 * @module
 */

import { execSync } from 'node:child_process';
import { loadProfile, listProfiles } from '../core/agent-profiles.js';
import { getDefaultInvokeTemplate } from '../core/agent-capability.js';
import { requireInitialized } from '../core/guards.js';

export interface RunProfileOptions {
  dry?: boolean;
  agent?: string;
  cwd?: string;
}

export function runRunProfile(profileName: string, options: RunProfileOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  requireInitialized(cwd);

  // List mode: no profile name
  if (!profileName) {
    const profiles = listProfiles(cwd);
    if (profiles.length === 0) {
      console.log('No agent profiles found. Add .yaml files to .brainclaw/agents/profiles/');
      return;
    }
    console.log('Available profiles:');
    for (const p of profiles) {
      console.log(`  ${p.name}  — ${p.description} [${p.trigger}]`);
    }
    return;
  }

  const profile = loadProfile(profileName, cwd);

  // Resolve invoke template: --agent override replaces the profile's invoke
  let invoke = profile.invoke;
  if (options.agent) {
    const template = getDefaultInvokeTemplate(options.agent);
    if (template) {
      invoke = template.command;
    } else {
      console.error(`Unknown agent: ${options.agent}. Using profile invoke template.`);
    }
  }

  // Replace {prompt} placeholder with the profile prompt. Escape backslashes
  // before quotes so a backslash in the prompt can't break out of the quoting.
  const command = invoke.replace(
    /\{prompt\}/g,
    profile.prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"'),
  );

  if (options.dry) {
    console.log(`[dry-run] Profile: ${profile.name}`);
    console.log(`[dry-run] Command: ${command}`);
    return;
  }

  console.log(`Running profile: ${profile.name}`);
  console.log(`Command: ${command}`);

  try {
    execSync(command, { cwd, stdio: 'inherit' });
  } catch (err: unknown) {
    const code = (err as { status?: number }).status ?? 1;
    process.exit(code);
  }
}
