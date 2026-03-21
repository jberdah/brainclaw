import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { memoryExists } from '../core/io.js';
import {
  applyBootstrapImport,
  renderBootstrapSummary,
  runBootstrapProfile,
  uninstallBootstrapImport,
} from '../core/bootstrap.js';

export interface BootstrapCommandOptions {
  for?: string;
  json?: boolean;
  refresh?: boolean;
  cwd?: string;
  apply?: boolean;
  uninstall?: boolean;
  yes?: boolean;
}

export async function runBootstrap(options: BootstrapCommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  try {
    if (options.apply && options.uninstall) {
      console.error('Error: --apply and --uninstall are mutually exclusive.');
      process.exit(1);
    }

    if (options.uninstall) {
      await confirmBootstrapAction('Remove the last bootstrap import?', options.yes);
      const result = uninstallBootstrapImport(cwd);
      if (!result.receipt) {
        console.log('No bootstrap import receipt found.');
        return;
      }
      console.log(`✔ Bootstrap uninstall completed: ${result.deactivatedCount} instruction(s) deactivated, ${result.skippedCount} artifact(s) skipped.`);
      return;
    }

    if (options.apply) {
      await confirmBootstrapAction('Apply the current bootstrap import proposal to canonical memory?', options.yes);
      const result = applyBootstrapImport({
        target: options.for,
        refresh: options.refresh,
        cwd,
      });
      console.log(`✔ Bootstrap import applied: ${result.createdCount} item(s) created, ${result.skippedCount} suggestion(s) skipped.`);
      if (result.receipt) {
        console.log(`✔ Receipt saved: ${result.receipt.managed_artifacts.length} managed artifact(s) can be reverted with \`brainclaw bootstrap --uninstall\`.`);
      }
      return;
    }

    const result = runBootstrapProfile({
      target: options.for,
      refresh: options.refresh,
      cwd,
    });
    if (options.json) {
      console.log(JSON.stringify({
        summary: result.profile.summary,
        target: result.profile.target,
        repo_fingerprint: result.profile.repo_fingerprint,
        sources_scanned: result.profile.sources_scanned,
        workspace_kind: result.profile.workspace_kind,
        confidence: result.profile.confidence,
        native_instruction_files: result.profile.native_instruction_files,
        gaps: result.profile.gaps,
        seed_count: result.profile.seed_count,
        seeds: result.seeds,
        import_plan: result.importPlan,
        last_application: result.lastApplication,
        reused_profile: result.reusedProfile,
      }, null, 2));
      return;
    }

    console.log(renderBootstrapSummary(result));
  } catch (error: unknown) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function confirmBootstrapAction(question: string, yes?: boolean): Promise<void> {
  if (yes) {
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`Error: ${question} Re-run with --yes in non-interactive mode.`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    if (answer.trim().toLowerCase() !== 'y') {
      console.error('Cancelled.');
      process.exit(1);
    }
  } catch (error: unknown) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}
