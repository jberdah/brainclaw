import { memoryExists } from '../core/io.js';
import { listCandidates, saveCandidate } from '../core/candidates.js';
import { loadConfig } from '../core/config.js';
import { buildReputationRankingLookup } from '../core/reputation.js';
import { runAccept } from './accept.js';
import { appendAuditEntry } from '../core/audit.js';

export interface ReviewOptions {
  json?: boolean;
  type?: string;
  prioritized?: boolean;
  onlyOverdue?: boolean;
  assignee?: string;
  forCurator?: string;
  take?: number;
  claim?: string;
  auto?: boolean;
  autoBy?: string;
}

export function runReview(options: ReviewOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let candidates = listCandidates('pending');
  const config = loadConfig();
  const slaHours = config.governance?.review_sla_hours ?? 24;
  const promotionThreshold = config.reflective_memory?.promotion_stars_threshold ?? 3;
  const promotionUsesThreshold = config.reflective_memory?.promotion_uses_threshold ?? 2;
  const now = Date.now();
  const rankingLookup = buildReputationRankingLookup();

  if (options.type) {
    candidates = candidates.filter(c => c.type === options.type);
  }

  if (options.assignee) {
    const targetAssignee = options.assignee.toLowerCase();
    candidates = candidates.filter((c) => getReviewAssignee(c.tags)?.toLowerCase() === targetAssignee);
  }

  if (options.forCurator) {
    const curator = options.forCurator.toLowerCase();
    candidates = candidates.filter((c) => getReviewAssignee(c.tags)?.toLowerCase() === curator);
  }

  if (options.onlyOverdue) {
    candidates = candidates.filter((c) => {
      const ageHours = Math.floor((now - Date.parse(c.created_at)) / (1000 * 60 * 60));
      return ageHours > slaHours;
    });
  }

  if (options.prioritized) {
    candidates = [...candidates].sort((a, b) => {
      const starDelta = (b.star_count ?? 0) - (a.star_count ?? 0);
      if (starDelta !== 0) return starDelta;
      const aRank = priorityRank(a.type);
      const bRank = priorityRank(b.type);
      if (aRank !== bRank) return aRank - bRank;
      const trustDelta = rankingLookup.getInternalTrust(b.author_id, b.author) - rankingLookup.getInternalTrust(a.author_id, a.author);
      if (trustDelta !== 0) return trustDelta;
      return a.created_at.localeCompare(b.created_at);
    });
  } else if (options.take && options.take > 0) {
    candidates = [...candidates].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  const totalBeforeTake = candidates.length;
  if (options.take && options.take > 0) {
    candidates = candidates.slice(0, options.take);
  }

  const claimed: typeof candidates = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  // --auto: auto-promote candidates that meet score threshold
  if (options.auto) {
    const scoreThreshold = config.reflective_memory?.auto_promote_score_threshold ?? 5;
    const autoBy = options.autoBy ?? process.env.USER ?? process.env.USERNAME ?? 'auto';
    const promoted: string[] = [];
    const autoSkipped: string[] = [];
    for (const c of candidates) {
      const score = (c.star_count ?? 0) + (c.usage_count ?? 0);
      if (score >= scoreThreshold ||
          (c.star_count ?? 0) >= promotionThreshold ||
          (c.usage_count ?? 0) >= promotionUsesThreshold) {
        try {
          runAccept(c.id, autoBy);
          promoted.push(c.id);
        } catch {
          autoSkipped.push(c.id);
        }
      } else {
        autoSkipped.push(c.id);
      }
    }
    if (options.json) {
      console.log(JSON.stringify({ auto_promoted: promoted, skipped: autoSkipped }));
    } else {
      console.log(`✔ Auto-promoted ${promoted.length} candidate(s). Skipped ${autoSkipped.length}.`);
    }
    return;
  }

  if (options.claim) {
    const curator = options.claim.trim();
    for (const c of candidates) {
      const existing = getReviewAssignee(c.tags);
      if (existing && existing.toLowerCase() !== curator.toLowerCase()) {
        skipped.push({ id: c.id, reason: `already assigned to ${existing}` });
        continue;
      }

      const updated = {
        ...c,
        tags: setReviewAssignee(c.tags, curator),
      };
      saveCandidate(updated);
      claimed.push(updated);
    }

    candidates = claimed;
  }

  if (options.json) {
    if (options.claim) {
      console.log(JSON.stringify({
        claimed: candidates.map((c) => {
          const ageHours = Math.floor((now - Date.parse(c.created_at)) / (1000 * 60 * 60));
          return {
            ...c,
            review_assignee: getReviewAssignee(c.tags),
            promotion_stars: c.star_count ?? 0,
            promotion_threshold: promotionThreshold,
            promotion_uses: c.usage_count ?? 0,
            promotion_uses_threshold: promotionUsesThreshold,
            promotion_recommended: (c.star_count ?? 0) >= promotionThreshold || (c.usage_count ?? 0) >= promotionUsesThreshold,
            age_hours: ageHours,
            sla_hours: slaHours,
            overdue: ageHours > slaHours,
          };
        }),
        skipped,
      }, null, 2));
      return;
    }

    const payload = candidates.map((c) => {
      const ageHours = Math.floor((now - Date.parse(c.created_at)) / (1000 * 60 * 60));
      return {
        ...c,
        review_assignee: getReviewAssignee(c.tags),
        promotion_stars: c.star_count ?? 0,
        promotion_threshold: promotionThreshold,
        promotion_uses: c.usage_count ?? 0,
        promotion_uses_threshold: promotionUsesThreshold,
        promotion_recommended: (c.star_count ?? 0) >= promotionThreshold || (c.usage_count ?? 0) >= promotionUsesThreshold,
        age_hours: ageHours,
        sla_hours: slaHours,
        overdue: ageHours > slaHours,
      };
    });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (candidates.length === 0) {
    if (options.claim) {
      console.log(`No candidates claimed for curator '${options.claim}'.`);
      if (skipped.length > 0) {
        console.log(`Skipped ${skipped.length} candidate(s) already assigned to another curator.`);
      }
      return;
    }
    console.log('No pending candidates.');
    return;
  }

  console.log(`${candidates.length} pending candidate(s):`);
  console.log('');
  if (options.prioritized) {
    console.log(`Priority mode enabled (SLA ${slaHours}h)`);
    console.log('');
  }
  if (options.take && options.take > 0) {
    console.log(`Showing ${candidates.length} of ${totalBeforeTake} candidate(s) (--take ${options.take})`);
    console.log('');
  }
  if (options.claim) {
    console.log(`Claimed ${candidates.length} candidate(s) for curator '${options.claim}'.`);
    if (skipped.length > 0) {
      console.log(`Skipped ${skipped.length} candidate(s) already assigned to another curator.`);
    }
    console.log('');
  }

  for (const c of candidates) {
    const tags = c.tags.length ? ` [${c.tags.join(', ')}]` : '';
    const extra = c.type === 'handoff' ? ` (${c.from} → ${c.to})` : '';
    const assignee = getReviewAssignee(c.tags);
    const assigneePart = assignee ? ` · assignee ${assignee}` : '';
    const stars = c.star_count ?? 0;
    const uses = c.usage_count ?? 0;
    const promote = stars >= promotionThreshold || uses >= promotionUsesThreshold ? ' · PROMOTE?' : '';
    const ageHours = Math.floor((now - Date.parse(c.created_at)) / (1000 * 60 * 60));
    const overdue = ageHours > slaHours ? ' OVERDUE' : '';
    console.log(`  [${c.id}] (${c.type}) ${c.text}${extra}${tags}`);
    console.log(`         by ${c.author} at ${c.created_at}${assigneePart} · stars ${stars}/${promotionThreshold} · uses ${uses}/${promotionUsesThreshold}${promote} · age ${ageHours}h · SLA ${slaHours}h${overdue}`);
  }
}

function setReviewAssignee(tags: string[], assignee: string): string[] {
  const next: string[] = [];
  for (const tag of tags) {
    if (!tag.startsWith('assignee:')) {
      next.push(tag);
    }
  }
  next.push(`assignee:${assignee}`);
  return next;
}

function getReviewAssignee(tags: string[]): string | undefined {
  for (const tag of tags) {
    if (tag.startsWith('assignee:')) {
      return tag.slice('assignee:'.length).trim() || undefined;
    }
  }
  return undefined;
}

function priorityRank(type: string): number {
  switch (type) {
    case 'handoff':
      return 1;
    case 'constraint':
      return 2;
    case 'trap':
      return 3;
    case 'decision':
    default:
      return 4;
  }
}
