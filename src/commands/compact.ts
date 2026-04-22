/**
 * CLI command: brainclaw compact
 *
 * LLM-driven semantic memory compaction — assess pressure or archive old items.
 *
 * @module
 */
import { memoryExists } from '../core/io.js';
import { compact as gcCompact, assessMemoryPressure, buildCompactionTemplate } from '../core/gc-semantic.js';

export interface CompactCliOptions {
  assess?: boolean;
  dryRun?: boolean;
  maxItems?: number;
  minAge?: number;
  noDedupHandoffs?: boolean;
  noPurgeClaims?: boolean;
  noPurgeSessionNotes?: boolean;
}

export function runCompact(options: CompactCliOptions = {}): void {
  if (!memoryExists(process.cwd())) {
    console.error('Project memory not initialized. Run `brainclaw init` first.');
    process.exit(1);
  }

  // --assess mode: show pressure assessment and template only, no archiving
  if (options.assess) {
    const assessment = assessMemoryPressure();
    const maxItems = options.maxItems ?? 20;
    const selected = assessment.eligible_items.slice(0, maxItems);

    console.log(`Memory pressure: ${assessment.pressure ? 'YES' : 'no'}`);
    console.log(`  Done plans: ${assessment.done_plans} (threshold: ${assessment.thresholds.plans})`);
    console.log(`  Closed handoffs: ${assessment.closed_handoffs} (threshold: ${assessment.thresholds.handoffs})`);
    console.log(`  Eligible items: ${assessment.eligible_items.length}`);

    if (selected.length > 0) {
      console.log('');
      console.log(buildCompactionTemplate(selected));
    } else {
      console.log('No items eligible for compaction.');
    }
    return;
  }

  // Default mode: compact (archive eligible items)
  const result = gcCompact({
    dryRun: options.dryRun,
    maxItems: options.maxItems,
    minAgeDays: options.minAge,
    dedupHandoffs: !options.noDedupHandoffs,
    purgeReleasedClaims: !options.noPurgeClaims,
    purgeSessionNotes: !options.noPurgeSessionNotes,
  });

  if (result.dry_run) {
    console.log(`🔍 Dry run — ${result.eligible_count} plan/handoff item(s) eligible for compaction.`);
  } else {
    console.log(`✔ Compacted ${result.archived_count}/${result.eligible_count} plan/handoff item(s).`);
    if (result.backup_path) {
      console.log(`Backup: ${result.backup_path}`);
    }
  }

  // Post-v1 extension summaries (pln#436)
  const extras: string[] = [];
  if ((result.claims_archived ?? 0) > 0) {
    extras.push(`${result.claims_archived} released claim(s)`);
  }
  if ((result.session_notes_archived ?? 0) > 0) {
    extras.push(`${result.session_notes_archived} session runtime_note(s)`);
  }
  if ((result.handoffs_deduped ?? 0) > 0) {
    extras.push(`${result.handoffs_deduped} duplicate handoff(s)`);
  }
  if (extras.length > 0) {
    const verb = result.dry_run ? 'eligible' : 'archived';
    console.log(`  • ${verb}: ${extras.join(', ')}`);
  }

  if (result.template) {
    console.log('');
    console.log(result.template);
  } else if (result.eligible_count === 0 && extras.length === 0) {
    console.log('No items eligible for compaction.');
  }
}
