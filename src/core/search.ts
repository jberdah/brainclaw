import { loadState } from './state.js';
import { listCandidates } from './candidates.js';
import { listSequences } from './sequence.js';
import type { State } from './schema.js';

export interface SearchResult {
  id: string;
  section: string;
  text: string;
  author?: string;
  created_at: string;
  tags: string[];
  related_paths?: string[];
  score: number;
}

export interface SearchCorpusDocument {
  id: string;
  section: string;
  text: string;
  author?: string;
  created_at: string;
  tags: string[];
  related_paths?: string[];
}

type SearchCorpusInput = Omit<SearchCorpusDocument, 'section'>;

interface BM25Doc extends SearchCorpusDocument {
  terms: string[];
}

const K1 = 1.5;
const B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_/-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function buildCorpus(state: State, includePending: boolean, cwd?: string): BM25Doc[] {
  const docs: BM25Doc[] = [];

  const add = (section: string, item: SearchCorpusInput) => {
    const textParts = [item.text, item.author ?? '', ...(item.tags ?? []), ...(item.related_paths ?? [])];
    docs.push({ ...item, section, terms: tokenize(textParts.join(' ')) });
  };

  for (const c of state.active_constraints) add('constraints', c);
  for (const d of state.recent_decisions) add('decisions', d);
  for (const t of state.known_traps) add('traps', { ...t, text: t.text });
  for (const h of state.open_handoffs) add('handoffs', { ...h, text: `${h.from} -> ${h.to}: ${h.text}` });
  for (const p of state.plan_items) add('plans', p);

  // Index sequences: combine name, description, item labels/lanes into searchable text
  try {
    const sequences = listSequences(cwd);
    for (const seq of sequences) {
      const itemTexts = (seq.items ?? []).map(
        (it) => [it.lane, it.scope_hint, (it as Record<string, unknown>).label as string, it.rationale].filter(Boolean).join(' '),
      );
      const text = [seq.name, seq.description ?? '', ...itemTexts].join(' — ');
      add('sequences', {
        id: seq.id,
        text,
        author: seq.author,
        created_at: seq.created_at,
        tags: seq.tags ?? [],
      });
    }
  } catch {
    // Sequences dir may not exist yet — non-fatal
  }

  if (includePending) {
    const candidates = listCandidates('pending');
    for (const c of candidates) add('candidates', { ...c, author: c.author });
  }

  return docs;
}

function bm25Score(queryTerms: string[], doc: BM25Doc, avgDocLen: number, idf: Map<string, number>): number {
  const docLen = doc.terms.length;
  let score = 0;
  const docTermFreq = new Map<string, number>();
  for (const t of doc.terms) {
    docTermFreq.set(t, (docTermFreq.get(t) ?? 0) + 1);
  }

  for (const term of queryTerms) {
    const tf = docTermFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const idfVal = idf.get(term) ?? 0;
    const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLen / avgDocLen)));
    score += idfVal * tfNorm;
  }

  return score;
}

export interface SearchOptions {
  query: string;
  section?: string;
  since?: string;
  tags?: string[];
  includePending?: boolean;
  maxResults?: number;
  cwd?: string;
}

export function searchCorpus(documents: SearchCorpusDocument[], options: Omit<SearchOptions, 'cwd' | 'includePending'>): SearchResult[] {
  const corpus = documents.map((document) => {
    const textParts = [document.text, document.author ?? '', ...(document.tags ?? []), ...(document.related_paths ?? [])];
    return {
      ...document,
      terms: tokenize(textParts.join(' ')),
    };
  });

  // Section filter
  const candidates = options.section
    ? corpus.filter(d => d.section === options.section)
    : corpus;

  // Tag filter
  const tagFiltered = options.tags && options.tags.length > 0
    ? candidates.filter(d => options.tags!.some(t => d.tags.includes(t)))
    : candidates;

  // Date filter
  const dateFiltered = options.since
    ? tagFiltered.filter(d => d.created_at >= options.since!)
    : tagFiltered;

  if (dateFiltered.length === 0) return [];

  const queryTerms = tokenize(options.query);
  if (queryTerms.length === 0) {
    // No query — return all sorted by date
    return dateFiltered
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, options.maxResults ?? 20)
      .map(d => ({ id: d.id, section: d.section, text: d.text, author: d.author, created_at: d.created_at, tags: d.tags, related_paths: d.related_paths, score: 0 }));
  }

  // Compute IDF
  const N = dateFiltered.length;
  const docFreq = new Map<string, number>();
  for (const term of queryTerms) {
    const df = dateFiltered.filter(d => d.terms.includes(term)).length;
    docFreq.set(term, df);
  }
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  const avgDocLen = dateFiltered.reduce((sum, d) => sum + d.terms.length, 0) / N;

  const scored = dateFiltered
    .map(d => ({ doc: d, score: bm25Score(queryTerms, d, avgDocLen, idf) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxResults ?? 20);

  return scored.map(r => ({
    id: r.doc.id,
    section: r.doc.section,
    text: r.doc.text,
    author: r.doc.author,
    created_at: r.doc.created_at,
    tags: r.doc.tags,
      related_paths: r.doc.related_paths,
      score: Math.round(r.score * 100) / 100,
  }));
}

export function search(options: SearchOptions): SearchResult[] {
  const state = loadState(options.cwd);
  const corpus = buildCorpus(state, options.includePending ?? false, options.cwd);
  return searchCorpus(corpus, options);
}
