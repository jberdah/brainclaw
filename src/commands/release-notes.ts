import { execFileSync } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import { memoryExists } from '../core/io.js';
import {
  checkBrainclawInstallableUpdate,
  getInstalledBrainclawVersion,
} from '../core/brainclaw-version.js';
import type { AgentReleaseNotes } from '../core/schema.js';

export interface ReleaseNotesOptions {
  json?: boolean;
  generate?: boolean;
  since?: string;
  cwd?: string;
}

/**
 * Generate agent-first release notes from git log since a given ref.
 * Returns structured notes suitable for --agent-release-notes.
 */
export function generateAgentReleaseNotes(
  cwd: string,
  since?: string,
): AgentReleaseNotes {
  const version = getInstalledBrainclawVersion();
  const baseRef = since ?? findLastVersionTag(cwd) ?? 'HEAD~20';

  let commits: string[];
  try {
    // Security: execFileSync (no shell) so baseRef cannot inject (Socket 2026-06-08 class).
    const raw = execFileSync('git', ['log', `${baseRef}..HEAD`, '--oneline', '--no-decorate'], {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
    });
    commits = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    commits = [];
  }

  if (commits.length === 0) {
    return {
      summary: `Brainclaw ${version} — no changes since last release.`,
      breaking_risk: 'none',
      action_recommendation: 'No update needed.',
    };
  }

  const highlights = categorizeCommits(commits);
  const hasBreaking = commits.some((c) => /breaking|BREAKING/i.test(c));
  const hasFix = commits.some((c) => /^[a-f0-9]+ fix/i.test(c));
  const hasFeat = commits.some((c) => /^[a-f0-9]+ feat/i.test(c));

  const summaryParts: string[] = [];
  if (hasFeat) summaryParts.push('new features');
  if (hasFix) summaryParts.push('bug fixes');
  if (!hasFeat && !hasFix) summaryParts.push('improvements');
  const summary = `Brainclaw ${version} — ${summaryParts.join(' and ')} (${commits.length} commits).`;

  const breakingRisk: AgentReleaseNotes['breaking_risk'] = hasBreaking ? 'high' : hasFeat ? 'low' : 'none';

  return {
    summary,
    agent_relevance: hasFeat
      ? 'New capabilities available — review highlights for agent workflow improvements.'
      : hasFix
        ? 'Bug fixes that may affect agent reliability.'
        : 'Maintenance release.',
    breaking_risk: breakingRisk,
    recommended_for: hasBreaking ? ['operators'] : ['all'],
    highlights: highlights.slice(0, 5),
    action_recommendation: hasBreaking
      ? 'Review breaking changes before updating. Operator confirmation recommended.'
      : 'Safe to update. No operator confirmation needed.',
  };
}

function findLastVersionTag(cwd: string): string | undefined {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return tag.length > 0 ? tag : undefined;
  } catch {
    return undefined;
  }
}

function categorizeCommits(commits: string[]): string[] {
  const highlights: string[] = [];
  const seen = new Set<string>();

  for (const commit of commits) {
    // Strip hash prefix
    const msg = commit.replace(/^[a-f0-9]+\s+/, '');
    const category = extractCategory(msg);
    if (category && !seen.has(category)) {
      seen.add(category);
      highlights.push(msg);
    }
  }

  // If not enough categorized, add uncategorized ones
  if (highlights.length < 5) {
    for (const commit of commits) {
      const msg = commit.replace(/^[a-f0-9]+\s+/, '');
      if (!highlights.includes(msg)) {
        highlights.push(msg);
        if (highlights.length >= 5) break;
      }
    }
  }

  return highlights;
}

function extractCategory(msg: string): string | undefined {
  const match = /^(feat|fix|chore|test|docs|refactor|perf|ci|build)\b/i.exec(msg);
  return match?.[1]?.toLowerCase();
}

export function runReleaseNotes(options: ReleaseNotesOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (options.generate) {
    const notes = generateAgentReleaseNotes(cwd, options.since);
    if (options.json) {
      console.log(JSON.stringify(notes, null, 2));
    } else {
      console.log(`Summary: ${notes.summary}`);
      if (notes.agent_relevance) console.log(`Agent relevance: ${notes.agent_relevance}`);
      console.log(`Breaking risk: ${notes.breaking_risk ?? 'none'}`);
      if (notes.recommended_for?.length) console.log(`Recommended for: ${notes.recommended_for.join(', ')}`);
      if (notes.highlights?.length) {
        console.log('Highlights:');
        for (const h of notes.highlights) console.log(`  • ${h}`);
      }
      if (notes.action_recommendation) console.log(`Action: ${notes.action_recommendation}`);
    }
    return;
  }

  // Show current release notes from configured update source
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const updateCheck = checkBrainclawInstallableUpdate(config, cwd, { useDefaultNpmSource: true });
  const arn = updateCheck.agent_release_notes;

  if (options.json) {
    console.log(JSON.stringify({
      status: updateCheck.status,
      latest_installable_version: updateCheck.latest_installable_version,
      agent_release_notes: arn ?? null,
      release_notes: updateCheck.release_notes ?? null,
    }, null, 2));
    return;
  }

  if (arn) {
    console.log(`Version: ${updateCheck.latest_installable_version ?? 'unknown'}`);
    console.log(`Summary: ${arn.summary}`);
    if (arn.agent_relevance) console.log(`Agent relevance: ${arn.agent_relevance}`);
    console.log(`Breaking risk: ${arn.breaking_risk ?? 'none'}`);
    if (arn.recommended_for?.length) console.log(`Recommended for: ${arn.recommended_for.join(', ')}`);
    if (arn.highlights?.length) {
      console.log('Highlights:');
      for (const h of arn.highlights) console.log(`  • ${h}`);
    }
    if (arn.action_recommendation) console.log(`Action: ${arn.action_recommendation}`);
  } else if (updateCheck.release_notes) {
    console.log(`Version: ${updateCheck.latest_installable_version ?? 'unknown'}`);
    console.log(updateCheck.release_notes);
  } else {
    console.log('No agent release notes available for the configured update source.');
    if (updateCheck.status === 'not_configured') {
      console.log('Configure brainclaw_update_source in your project config to enable update checks.');
    }
  }
}
