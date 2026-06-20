/**
 * Brainclaw Code Map — universal vocabulary (spec §5, dec#108 #4).
 *
 * Defines the cross-language universal node-subtype and edge-kind sets, plus
 * the namespacing rule for provider-specific extensions. A `NodeSubtype` /
 * `EdgeKind` is EITHER one of the universal values OR a lowercase,
 * provider-prefixed namespaced value of the form `provider.subtype`
 * (e.g. `rust.trait`). The matching runtime validator lives in `types.ts`.
 *
 * P1a emits ONLY the existing universal values — providers MUST NOT introduce
 * new universal subtypes/edge kinds here without a spec change.
 */

/**
 * Universal symbol subtypes shared across every language provider (spec §5).
 * Ordering is documentary only; nothing depends on array order.
 */
export const UniversalNodeSubtypes = [
  'function',
  'method',
  'constructor',
  'class',
  'type',
  'interface',
  'enum',
  'variable',
  'constant',
  'field',
  'property',
  'namespace',
  'package',
  'component',
  'hook',
  'test',
  'test_suite',
  'macro',
  'export',
] as const;

/** A universal symbol subtype (member of {@link UniversalNodeSubtypes}). */
export type UniversalNodeSubtype = (typeof UniversalNodeSubtypes)[number];

/**
 * A symbol subtype: either a universal value or a provider-namespaced value
 * matching `^[a-z]+\.[a-z_]+$` (e.g. `rust.trait`). The namespaced arm is a
 * widened template-literal type — runtime narrowing is enforced by the zod
 * validator in `types.ts`.
 */
export type NodeSubtype = UniversalNodeSubtype | `${string}.${string}`;

/**
 * Universal edge kinds shared across every language provider (spec §5).
 * Ordering is documentary only; nothing depends on array order.
 */
export const UniversalEdgeKinds = [
  'contains',
  'defines',
  'imports',
  'exports',
  'resolves_to',
  'imports_symbol',
  'tests_for',
  'extends',
  'implements',
  'annotates',
  'has_receiver',
] as const;

/** A universal edge kind (member of {@link UniversalEdgeKinds}). */
export type UniversalEdgeKind = (typeof UniversalEdgeKinds)[number];

/**
 * An edge kind: either a universal value or a provider-namespaced value
 * matching `^[a-z]+\.[a-z_]+$`. Same namespacing rule as {@link NodeSubtype}.
 */
export type EdgeKind = UniversalEdgeKind | `${string}.${string}`;

/** Regex used by `types.ts` to validate provider-namespaced vocabulary values. */
export const NAMESPACED_VOCAB_RE = /^[a-z]+\.[a-z_]+$/;

/**
 * Maps a capture name produced by a provider's tags/imports queries onto a
 * draft field. Optional `subtype`/`kind` carry the resolved vocabulary value
 * for `@definition.<subtype>.*` / edge captures. `optional` marks captures the
 * runtime may legitimately not find on a given node.
 */
export interface CaptureMapping {
  /** Tree-sitter capture name, e.g. `@definition.function.node`. */
  readonly capture: string;
  /** Draft field this capture feeds (e.g. `name`, `node`, `exported`, `source`). */
  readonly field: string;
  /** Resolved universal/namespaced subtype for `@definition.*` captures. */
  readonly subtype?: NodeSubtype;
  /** Resolved universal/namespaced edge kind for edge-bearing captures. */
  readonly kind?: EdgeKind;
  /** Whether the runtime may omit this capture without erroring. */
  readonly optional?: boolean;
}

/**
 * A provider's declared vocabulary: the subtypes and edge kinds it may emit,
 * optional aliases mapping provider-local names onto universal values, and the
 * capture→draft mapping. The CORE finalizer/validator uses this to assert a
 * provider stays within its declared surface (spec §5, §7 captureMap).
 */
export interface ProviderVocabularyDeclaration {
  /** Subtypes this provider may emit (universal and/or namespaced). */
  readonly nodeSubtypes: readonly NodeSubtype[];
  /** Edge kinds this provider may emit (universal and/or namespaced). */
  readonly edgeKinds: readonly EdgeKind[];
  /** Optional aliases mapping a provider-local label onto a universal value. */
  readonly aliases?: Readonly<Record<string, UniversalNodeSubtype | UniversalEdgeKind>>;
  /** Capture-name → draft-field mappings for this provider's queries. */
  readonly captureMap: readonly CaptureMapping[];
}
