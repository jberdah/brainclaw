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
  });

  if (result.dry_run) {
    console.log(`🔍 Dry run — ${result.eligible_count} item(s) eligible for compaction.`);
  } else {
    console.log(`✔ Compacted ${result.archived_count}/${result.eligible_count} item(s).`);
    if (result.backup_path) {
      console.log(`Backup: ${result.backup_path}`);
    }
  }

  if (result.template) {
    console.log('');
    console.log(result.template);
  } else if (result.eligible_count === 0) {
    console.log('No items eligible for compaction.');
  }
}
