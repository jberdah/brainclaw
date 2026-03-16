import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../core/config.js';
import { memoryExists } from '../core/io.js';
import {
  assessBrainclawVersion,
  checkBrainclawInstallableUpdate,
  DEFAULT_LOCAL_RELEASE_MANIFEST_PATH,
  publishLocalBrainclawRelease,
} from '../core/brainclaw-version.js';

export interface VersionOptions {
  check?: boolean;
  json?: boolean;
  publishLocal?: boolean;
  releaseNotes?: string;
  cwd?: string;
}

export function runVersion(options: VersionOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const initialized = memoryExists(cwd);
  let config = initialized ? loadConfig(cwd) : undefined;
  let publishedLocalRelease: ReturnType<typeof publishLocalBrainclawRelease> | undefined;

  if (options.publishLocal) {
    if (!initialized || !config) {
      console.error('Error: local release publishing requires an initialized Brainclaw project.');
      process.exit(1);
    }

    try {
      publishedLocalRelease = publishLocalBrainclawRelease(cwd, {
        releaseNotes: options.releaseNotes,
      });
      config.brainclaw_update_source = {
        type: 'local-pack',
        manifest_path: DEFAULT_LOCAL_RELEASE_MANIFEST_PATH,
      };
      saveConfig(config, cwd);
      ensureLocalReleasesGitignore(cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: failed to publish local release channel: ${message}`);
      process.exit(1);
    }
  }

  const assessment = assessBrainclawVersion(config);
  const updateCheck = options.check ? checkBrainclawInstallableUpdate(config, cwd) : undefined;

  const result = {
    initialized,
    ...assessment,
    ...(publishedLocalRelease ? { published_local_release: publishedLocalRelease } : {}),
    ...(updateCheck ? { installable_update: updateCheck } : {}),
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`brainclaw ${assessment.cli_version}`);
  if (!initialized) {
    console.log('Project memory: not initialized');
    return;
  }

  if (publishedLocalRelease) {
    console.log(`Local release published: ${publishedLocalRelease.workspace_version}`);
    console.log(`Manifest: ${publishedLocalRelease.manifest_path}`);
    console.log(`Artifact: ${publishedLocalRelease.artifact_path}`);
    console.log(`Install command: ${publishedLocalRelease.install_command}`);
  }
  if (assessment.minimum_brainclaw_version) {
    console.log(`Minimum required: ${assessment.minimum_brainclaw_version}`);
  }
  if (assessment.recommended_brainclaw_version) {
    console.log(`Recommended: ${assessment.recommended_brainclaw_version}`);
  }
  console.log(assessment.message);
  if (assessment.upgrade_message) {
    console.log(`Upgrade benefits: ${assessment.upgrade_message}`);
  }
  if (assessment.upgrade_command) {
    console.log(`Upgrade command: ${assessment.upgrade_command}`);
  }
  if (!updateCheck) {
    return;
  }

  console.log(updateCheck.message);
  if (updateCheck.latest_installable_version) {
    console.log(`Latest installable: ${updateCheck.latest_installable_version}`);
  }
  if (updateCheck.release_notes) {
    console.log(`Release notes: ${updateCheck.release_notes}`);
  }
  if (updateCheck.install_command) {
    console.log(`Install command: ${updateCheck.install_command}`);
  }
}

function ensureLocalReleasesGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const ignoreLine = '.releases/';
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  if (lines.has(ignoreLine)) {
    return;
  }

  const trimmed = current.trimEnd();
  const separator = trimmed.length > 0 ? '\n' : '';
  const next = `${trimmed}${separator}\n# Local installable Brainclaw releases\n${ignoreLine}\n`;
  fs.writeFileSync(gitignorePath, next, 'utf-8');
}
