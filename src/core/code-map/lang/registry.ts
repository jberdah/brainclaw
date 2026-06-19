/**
 * Code Map P1a — CodeLanguageRegistry implementation (spec §4).
 *
 * Maps file extensions → providers (deterministic on collision: higher `priority`
 * wins, then earlier registration), and runtime langs → providers. Surfaces the
 * freshness inputs (provider versions + every query-asset hash per lang) and the
 * `manifest.languages` entries keyed by runtime CodeLang.
 *
 * No behavior change in P1a — refresh.ts is NOT yet routed through this (Sprint 4
 * cutover). The registry exists so the new core path can resolve a provider for a
 * path and so freshness can fold in query-asset hashes.
 */
import path from 'node:path';
import type { CodeLang } from '../types.js';
import type {
  CodeLanguageProvider,
  CodeLanguageRegistry,
  RegistryLanguageEntry,
} from './provider.js';

interface Registration {
  readonly provider: CodeLanguageProvider;
  /** Monotonic registration index — the secondary collision tiebreak. */
  readonly order: number;
}

export class DefaultCodeLanguageRegistry implements CodeLanguageRegistry {
  private readonly registrations: Registration[] = [];
  private nextOrder = 0;

  register(p: CodeLanguageProvider): void {
    this.registrations.push({ provider: p, order: this.nextOrder++ });
  }

  /**
   * Resolve the provider owning a path's extension. On collision: highest
   * `priority` (default 0) wins; ties broken by EARLIEST registration order.
   */
  providerForPath(path_: string): { provider: CodeLanguageProvider; lang: CodeLang } | null {
    const ext = path.extname(path_).toLowerCase();
    if (!ext) return null;
    const candidates = this.registrations.filter((r) =>
      r.provider.extensions.some((e) => e.toLowerCase() === ext),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const pa = a.provider.priority ?? 0;
      const pb = b.provider.priority ?? 0;
      if (pa !== pb) return pb - pa; // higher priority first
      return a.order - b.order; // then earliest registration
    });
    const provider = candidates[0].provider;
    return { provider, lang: provider.langForPath(path_) };
  }

  providerForLang(lang: CodeLang): CodeLanguageProvider | null {
    // Same collision rule as providerForPath, applied over `languages`.
    const candidates = this.registrations.filter((r) => r.provider.languages.includes(lang));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const pa = a.provider.priority ?? 0;
      const pb = b.provider.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.order - b.order;
    });
    return candidates[0].provider;
  }

  activeLanguages(): CodeLang[] {
    const seen = new Set<CodeLang>();
    const out: CodeLang[] = [];
    for (const { provider } of this.registrations) {
      for (const lang of provider.languages) {
        if (!seen.has(lang)) {
          seen.add(lang);
          out.push(lang);
        }
      }
    }
    return out;
  }

  includedExtensions(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const { provider } of this.registrations) {
      for (const ext of provider.extensions) {
        const e = ext.toLowerCase();
        if (!seen.has(e)) {
          seen.add(e);
          out.push(e);
        }
      }
    }
    return out;
  }

  /**
   * `manifest.languages` entries keyed by runtime CodeLang. The winning provider
   * per lang (collision rule) supplies the grammar name/version/hash.
   */
  languageEntries(): Record<string, RegistryLanguageEntry> {
    const out: Record<string, RegistryLanguageEntry> = {};
    for (const lang of this.activeLanguages()) {
      const provider = this.providerForLang(lang);
      if (!provider) continue;
      out[lang] = {
        enabled: true,
        grammar_name: provider.parser.grammarNameForLang(lang),
        grammar_version: provider.version,
        tree_sitter_grammar_hash: provider.parser.grammarHashForLang(lang),
      };
    }
    return out;
  }

  /**
   * Freshness inputs: per provider, its `version` + every query-asset hash for
   * every lang it owns. Editing a `.scm` flips a hash here → `stale_extractor`.
   * Deterministically ordered (registration order, then lang order).
   */
  configHashInputs(): unknown {
    return this.registrations.map(({ provider }) => ({
      id: provider.id,
      version: provider.version,
      queries: provider.languages.map((lang) => ({
        lang,
        tags: provider.queries.tags.hashForLang(lang),
        imports: provider.queries.imports.hashForLang(lang),
      })),
    }));
  }
}

/** Convenience: build a registry pre-loaded with the given providers. */
export function createRegistry(...providers: CodeLanguageProvider[]): DefaultCodeLanguageRegistry {
  const reg = new DefaultCodeLanguageRegistry();
  for (const p of providers) reg.register(p);
  return reg;
}
