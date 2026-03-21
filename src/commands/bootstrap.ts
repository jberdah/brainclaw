import { memoryExists } from '../core/io.js';
import { renderBootstrapSummary, runBootstrapProfile } from '../core/bootstrap.js';

export interface BootstrapCommandOptions {
  for?: string;
  json?: boolean;
  refresh?: boolean;
  cwd?: string;
}

export function runBootstrap(options: BootstrapCommandOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  try {
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
