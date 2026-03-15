import type {
  CandidateContradiction,
  Constraint,
  ContradictionSeverity,
  Decision,
  State,
} from './schema.js';

export interface ContradictionReport extends CandidateContradiction {}

interface ContradictionSignal {
  kind: string;
  reason: string;
  score: number;
}

type ContradictionComparable = Pick<Constraint | Decision, 'id' | 'text' | 'tags' | 'related_paths' | 'project_id'>;

const NEGATION_PAIRS: Array<{ positive: string; negative: string; kind: string }> = [
  { positive: 'must', negative: 'must not', kind: 'negation_pair' },
  { positive: 'must', negative: 'must never', kind: 'negation_pair' },
  { positive: 'should', negative: 'should not', kind: 'negation_pair' },
  { positive: 'should', negative: 'should never', kind: 'negation_pair' },
  { positive: 'always', negative: 'never', kind: 'negation_pair' },
  { positive: 'enable', negative: 'disable', kind: 'toggle_pair' },
  { positive: 'enabled', negative: 'disabled', kind: 'toggle_pair' },
  { positive: 'use', negative: 'do not use', kind: 'usage_pair' },
  { positive: 'use', negative: 'avoid', kind: 'usage_pair' },
  { positive: 'allow', negative: 'block', kind: 'policy_pair' },
  { positive: 'allow', negative: 'deny', kind: 'policy_pair' },
  { positive: 'required', negative: 'forbidden', kind: 'policy_pair' },
];

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'must',
  'must not',
  'must never',
  'should',
  'should not',
  'should never',
  'always',
  'never',
  'enable',
  'disable',
  'enabled',
  'disabled',
  'use',
  'do not use',
  'avoid',
  'allow',
  'block',
  'deny',
  'required',
  'forbidden',
]);

export function detectContradictions(state: State): ContradictionReport[] {
  const reports: ContradictionReport[] = [];
  const constraints = state.active_constraints.filter((constraint) => constraint.status === 'active');
  const decisions = state.recent_decisions;

  comparePairs(constraints, 'constraints', reports);
  comparePairs(decisions, 'decisions', reports);
  compareCrossSection(constraints, decisions, reports);

  return sortContradictions(reports);
}

export function detectNewItemContradictions(
  newText: string,
  newTags: string[],
  newPaths: string[] | undefined,
  state: State,
  newProjectId?: string,
): ContradictionReport[] {
  const reports: ContradictionReport[] = [];
  const candidate: ContradictionComparable = {
    id: 'new_item',
    text: newText,
    tags: newTags,
    related_paths: newPaths,
    project_id: newProjectId,
  };

  const check = (existing: ContradictionComparable, section: string): void => {
    const signal = detectComparableContradiction(candidate, existing);
    if (!signal) {
      return;
    }
    reports.push({
      item_id: candidate.id,
      conflicts_with: existing.id,
      reason: signal.reason,
      section,
      score: signal.score,
      severity: classifySeverity(signal.score),
      kind: signal.kind,
    });
  };

  for (const constraint of state.active_constraints.filter((item) => item.status === 'active')) {
    check(constraint, 'constraints');
  }
  for (const decision of state.recent_decisions) {
    check(decision, 'decisions');
  }

  return sortContradictions(reports);
}

export function summarizeContradictions(reports: ContradictionReport[], maxItems: number = 2): string | undefined {
  if (reports.length === 0) {
    return undefined;
  }

  const parts = reports.slice(0, maxItems).map((report) => `[${report.conflicts_with}] ${report.reason}`);
  const suffix = reports.length > maxItems ? ` (+${reports.length - maxItems} more)` : '';
  return `${reports.length} contradiction(s): ${parts.join('; ')}${suffix}`;
}

export function hasBlockingContradictions(reports: ContradictionReport[]): boolean {
  return reports.some((report) => report.severity === 'medium' || report.severity === 'high');
}

function comparePairs(items: ContradictionComparable[], section: string, reports: ContradictionReport[]): void {
  for (let index = 0; index < items.length; index++) {
    for (let offset = index + 1; offset < items.length; offset++) {
      const left = items[index]!;
      const right = items[offset]!;
      const signal = detectComparableContradiction(left, right);
      if (!signal) {
        continue;
      }
      reports.push({
        item_id: left.id,
        conflicts_with: right.id,
        reason: signal.reason,
        section,
        score: signal.score,
        severity: classifySeverity(signal.score),
        kind: signal.kind,
      });
    }
  }
}

function compareCrossSection(
  constraints: ContradictionComparable[],
  decisions: ContradictionComparable[],
  reports: ContradictionReport[],
): void {
  for (const constraint of constraints) {
    for (const decision of decisions) {
      const signal = detectComparableContradiction(constraint, decision);
      if (!signal) {
        continue;
      }
      reports.push({
        item_id: constraint.id,
        conflicts_with: decision.id,
        reason: signal.reason,
        section: 'constraints_vs_decisions',
        score: signal.score,
        severity: classifySeverity(signal.score),
        kind: signal.kind,
      });
    }
  }
}

function detectComparableContradiction(left: ContradictionComparable, right: ContradictionComparable): ContradictionSignal | undefined {
  const domain = scoreDomainOverlap(left, right);
  if (domain <= 0) {
    return undefined;
  }

  const lexical = detectLexicalConflict(left.text, right.text);
  if (!lexical) {
    return undefined;
  }

  return {
    kind: lexical.kind,
    reason: lexical.reason,
    score: lexical.score + domain,
  };
}

function detectLexicalConflict(leftText: string, rightText: string): ContradictionSignal | undefined {
  const normalizedLeft = normalize(leftText);
  const normalizedRight = normalize(rightText);
  const tokensLeft = tokenSet(normalizedLeft);
  const tokensRight = tokenSet(normalizedRight);
  const shared = sharedTokens(tokensLeft, tokensRight);
  const jaccard = jaccardIndex(tokensLeft, tokensRight);

  for (const pair of NEGATION_PAIRS) {
    const leftHasPositive = normalizedLeft.includes(pair.positive);
    const leftHasNegative = normalizedLeft.includes(pair.negative);
    const rightHasPositive = normalizedRight.includes(pair.positive);
    const rightHasNegative = normalizedRight.includes(pair.negative);
    if (!((leftHasPositive && rightHasNegative) || (leftHasNegative && rightHasPositive))) {
      continue;
    }

    if (shared.length === 0 && jaccard < 0.15) {
      return undefined;
    }

    const overlapBoost = Math.min(shared.length, 3);
    const score = 5 + overlapBoost + Math.round(jaccard * 4);
    const overlapSummary = shared.slice(0, 3).join(', ');
    const overlapText = overlapSummary ? ` around ${overlapSummary}` : '';
    return {
      kind: pair.kind,
      reason: `"${pair.positive}" vs "${pair.negative}"${overlapText}`,
      score,
    };
  }

  return undefined;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(normalized: string): Set<string> {
  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

function sharedTokens(left: Set<string>, right: Set<string>): string[] {
  const result: string[] = [];
  for (const token of left) {
    if (right.has(token)) {
      result.push(token);
    }
  }
  return result.sort();
}

function jaccardIndex(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  const intersection = sharedTokens(left, right).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function scoreDomainOverlap(left: ContradictionComparable, right: ContradictionComparable): number {
  let score = 0;
  if (pathsOverlap(left.related_paths, right.related_paths)) {
    score += 3;
  }
  if (tagsOverlap(left.tags, right.tags)) {
    score += 2;
  }
  if (left.project_id && right.project_id && left.project_id === right.project_id) {
    score += 1;
  }
  return score;
}

function classifySeverity(score: number): ContradictionSeverity {
  if (score >= 10) {
    return 'high';
  }
  if (score >= 7) {
    return 'medium';
  }
  return 'low';
}

function pathsOverlap(left?: string[], right?: string[]): boolean {
  if (!left || !right || left.length === 0 || right.length === 0) {
    return false;
  }
  return left.some((leftPath) => right.some((rightPath) => leftPath.startsWith(rightPath) || rightPath.startsWith(leftPath) || leftPath === rightPath));
}

function tagsOverlap(left: string[], right: string[]): boolean {
  return left.some((tag) => right.includes(tag));
}

function sortContradictions(reports: ContradictionReport[]): ContradictionReport[] {
  const severityRank: Record<ContradictionSeverity, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  return [...reports].sort((left, right) => {
    const severityDelta = severityRank[right.severity] - severityRank[left.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.conflicts_with.localeCompare(right.conflicts_with);
  });
}
