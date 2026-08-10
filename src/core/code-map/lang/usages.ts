/**
 * P4 lexical usage extraction shared by the JS/TS and Python providers.
 *
 * This deliberately recognizes only bare identifier uses. A property/method access
 * is never resolved as a call: when its property text happens to equal a local
 * function it is retained only as `possible_textual_match` at low confidence.
 * Imported bindings stay as candidates until the project resolver proves exactly
 * one importable symbol in the resolved target file.
 */
import type { Node as TsNode } from 'web-tree-sitter';
import type { DefinitionDraft, UsageDraft } from '../drafts.js';
import type { Span } from '../types.js';

type UsageLanguage = 'js-ts' | 'python';

interface DefSourceNode {
  node: TsNode;
  nameNode: TsNode;
}

interface ImportedBinding {
  readonly module: string;
  readonly importedName: string;
  readonly bindingNode: TsNode;
}

const FUNCTION_SUBTYPES = new Set(['function', 'component', 'hook']);
const LOW_CONFIDENCE_TEXTUAL_MATCH = 0.2;

function sourceOf(definition: DefinitionDraft): DefSourceNode | null {
  const value = definition.sourceNode;
  if (!value || typeof value !== 'object' || !('node' in value) || !('nameNode' in value)) return null;
  const candidate = value as Partial<DefSourceNode>;
  return candidate.node && candidate.nameNode ? candidate as DefSourceNode : null;
}

function spanOf(node: TsNode): Span {
  return {
    start_line: node.startPosition.row + 1,
    start_col: node.startPosition.column + 1,
    end_line: node.endPosition.row + 1,
    end_col: node.endPosition.column + 1,
  };
}

function nodeKey(node: TsNode): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

function sameNode(a: TsNode | null, b: TsNode): boolean {
  return !!a && a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

function field(node: TsNode, name: string): TsNode | null {
  try {
    return node.childForFieldName(name);
  } catch {
    return null;
  }
}

function walk(node: TsNode, visit: (node: TsNode) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, visit);
  }
}

function walkScope(
  node: TsNode,
  rootScope: TsNode,
  language: UsageLanguage,
  visit: (node: TsNode) => void,
): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    // Bindings in a nested function/class/lambda cannot shadow a use in this
    // scope. Skipping them avoids false abstention between sibling functions.
    if (child !== rootScope && isScope(child, language)) continue;
    walkScope(child, rootScope, language, visit);
  }
}

function hasAncestor(node: TsNode, types: ReadonlySet<string>): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (types.has(parent.type)) return true;
  }
  return false;
}

function isTopLevelPythonFunction(definition: DefinitionDraft): boolean {
  const source = sourceOf(definition);
  if (!source) return false;
  let parent = source.node.parent;
  if (parent?.type === 'decorated_definition') parent = parent.parent;
  return parent?.type === 'module';
}

function isLocalFunctionTarget(definition: DefinitionDraft, language: UsageLanguage): boolean {
  if (!FUNCTION_SUBTYPES.has(definition.subtype)) return false;
  // JS/TS tags are already program-anchored. Python captures nested functions too,
  // so retain only module bindings: nested/method names need a real scope engine.
  return language === 'js-ts' || isTopLevelPythonFunction(definition);
}

function isCallerDefinition(definition: DefinitionDraft): boolean {
  return FUNCTION_SUBTYPES.has(definition.subtype);
}

function definitionRange(definition: DefinitionDraft): TsNode | null {
  const source = sourceOf(definition);
  if (!source) return null;
  // A lexical declaration can carry several declarators. The declarator, not the
  // shared statement span, is the smallest safe caller container for an arrow.
  return source.nameNode.parent ?? source.node;
}

function contains(container: TsNode, node: TsNode): boolean {
  return container.startIndex <= node.startIndex && container.endIndex >= node.endIndex;
}

function callerFor(node: TsNode, definitions: readonly DefinitionDraft[]): number | undefined {
  let winner: { ordinal: number; width: number } | undefined;
  for (const definition of definitions) {
    if (!isCallerDefinition(definition)) continue;
    const range = definitionRange(definition);
    if (!range || !contains(range, node)) continue;
    const width = range.endIndex - range.startIndex;
    if (!winner || width < winner.width || (width === winner.width && definition.ordinal > winner.ordinal)) {
      winner = { ordinal: definition.ordinal, width };
    }
  }
  return winner?.ordinal;
}

function isScope(node: TsNode, language: UsageLanguage): boolean {
  if (language === 'python') return ['module', 'function_definition', 'lambda', 'class_definition'].includes(node.type);
  return ['program', 'function_declaration', 'function_expression', 'arrow_function', 'method_definition'].includes(node.type);
}

function isParameterIdentifier(node: TsNode, language: UsageLanguage): boolean {
  const parameterTypes = language === 'python'
    ? new Set(['parameters', 'lambda_parameters'])
    : new Set(['formal_parameters', 'required_parameter', 'optional_parameter', 'rest_pattern']);
  return hasAncestor(node, parameterTypes);
}

function isBindingIdentifier(node: TsNode, language: UsageLanguage): boolean {
  if (node.type !== 'identifier') return false;
  const parent = node.parent;
  if (!parent) return false;
  if (sameNode(field(parent, 'name'), node) && [
    'variable_declarator', 'function_declaration', 'generator_function_declaration',
    'function_definition', 'class_declaration', 'class_definition', 'aliased_import',
  ].includes(parent.type)) return true;
  if (sameNode(field(parent, 'left'), node) && [
    'assignment', 'augmented_assignment', 'for_statement', 'with_item',
  ].includes(parent.type)) return true;
  return isParameterIdentifier(node, language);
}

function scopeBinds(scope: TsNode, name: string, language: UsageLanguage, allowed: ReadonlySet<string>): boolean {
  let found = false;
  walkScope(scope, scope, language, (candidate) => {
    if (found || candidate.text !== name || !isBindingIdentifier(candidate, language)) return;
    if (!allowed.has(nodeKey(candidate))) found = true;
  });
  return found;
}

function isShadowed(node: TsNode, name: string, language: UsageLanguage, allowed: ReadonlySet<string>): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isScope(parent, language) && scopeBinds(parent, name, language, allowed)) return true;
  }
  return false;
}

function propertyOf(node: TsNode): TsNode | null {
  return field(node, 'property') ?? field(node, 'attribute');
}

function isProperty(node: TsNode): boolean {
  const parent = node.parent;
  return !!parent && sameNode(propertyOf(parent), node)
    && ['member_expression', 'optional_member_expression', 'attribute'].includes(parent.type);
}

function isValueReference(node: TsNode, language: UsageLanguage): boolean {
  if (node.type !== 'identifier' || isBindingIdentifier(node, language)) return false;
  const parent = node.parent;
  if (!parent || isProperty(node)) return false;
  if (hasAncestor(node, new Set(['import_statement', 'import_from_statement']))) return false;
  if (sameNode(field(parent, 'key'), node) || ['export_specifier', 'export_clause'].includes(parent.type)) return false;
  // Type positions have distinct namespaces in TS and do not prove a value-level use.
  if (hasAncestor(node, new Set(['type_annotation', 'type_alias_declaration', 'interface_declaration', 'type_identifier']))) return false;
  return true;
}

function addBinding(
  bindings: Map<string, ImportedBinding | null>,
  localName: string,
  binding: ImportedBinding,
): void {
  const previous = bindings.get(localName);
  bindings.set(localName, previous === undefined ? binding : null);
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

function jsTsBindings(root: TsNode): Map<string, ImportedBinding | null> {
  const bindings = new Map<string, ImportedBinding | null>();
  walk(root, (statement) => {
    if (statement.type !== 'import_statement') return;
    const source = field(statement, 'source');
    if (!source) return;
    const module = stripQuotes(source.text);
    let clause: TsNode | null = null;
    for (let i = 0; i < statement.namedChildCount; i++) {
      const child = statement.namedChild(i);
      if (child?.type === 'import_clause') { clause = child; break; }
    }
    if (!clause) return;
    walk(clause, (candidate) => {
      if (candidate.type !== 'import_specifier') return;
      const imported = field(candidate, 'name');
      if (!imported || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(imported.text)) return;
      const alias = field(candidate, 'alias');
      addBinding(bindings, (alias ?? imported).text, {
        module,
        importedName: imported.text,
        bindingNode: alias ?? imported,
      });
    });
  });
  return bindings;
}

function pythonBindings(root: TsNode): Map<string, ImportedBinding | null> {
  const bindings = new Map<string, ImportedBinding | null>();
  walk(root, (statement) => {
    if (statement.type !== 'import_from_statement') return;
    const source = field(statement, 'module_name');
    if (!source) return;
    const module = source.text;
    for (let i = 0; i < statement.namedChildCount; i++) {
      const child = statement.namedChild(i);
      if (!child || sameNode(child, source)) continue;
      if (child.type === 'dotted_name' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(child.text)) {
        addBinding(bindings, child.text, { module, importedName: child.text, bindingNode: child });
      } else if (child.type === 'aliased_import') {
        const imported = field(child, 'name');
        const alias = field(child, 'alias');
        if (imported && alias && /^[A-Za-z_][A-Za-z0-9_]*$/.test(imported.text)) {
          addBinding(bindings, alias.text, { module, importedName: imported.text, bindingNode: alias });
        }
      }
    }
  });
  return bindings;
}

/** Extract provider-local, soundness-first usage drafts from an already parsed tree. */
export function extractLexicalUsages(
  root: TsNode | null | undefined,
  definitions: readonly DefinitionDraft[],
  language: UsageLanguage,
): UsageDraft[] {
  if (!root) return [];

  const localTargets = new Map<string, DefinitionDraft | null>();
  const allowedBindings = new Set<string>();
  for (const definition of definitions) {
    if (!isLocalFunctionTarget(definition, language)) continue;
    const previous = localTargets.get(definition.name);
    localTargets.set(definition.name, previous === undefined ? definition : null);
    const source = sourceOf(definition);
    if (source) allowedBindings.add(nodeKey(source.nameNode));
  }
  const bindings = language === 'js-ts' ? jsTsBindings(root) : pythonBindings(root);
  for (const binding of bindings.values()) if (binding) allowedBindings.add(nodeKey(binding.bindingNode));

  const usages: UsageDraft[] = [];
  const seen = new Set<string>();
  const handledCallIdentifiers = new Set<string>();
  const handledProperties = new Set<string>();

  const add = (node: TsNode, kind: UsageDraft['kind'], target: UsageDraft['target']): void => {
    const caller = callerFor(node, definitions);
    const targetKey = target.kind === 'local'
      ? `local:${target.definitionOrdinal}`
      : `import:${target.module}:${target.importedName}`;
    const key = `${nodeKey(node)}:${kind}:${caller ?? 'file'}:${targetKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    usages.push({
      kind,
      ...(caller === undefined ? {} : { fromDefinitionOrdinal: caller }),
      target,
      span: spanOf(node),
      confidence: kind === 'possible_textual_match' ? LOW_CONFIDENCE_TEXTUAL_MATCH : 1.0,
    });
  };

  const directUse = (node: TsNode, kind: 'calls' | 'references'): void => {
    const name = node.text;
    const local = localTargets.get(name);
    const imported = bindings.get(name);
    if ((local === undefined || local === null) && (!imported || imported === null)) return;
    if (isShadowed(node, name, language, allowedBindings)) return;
    if (local && local !== null) {
      add(node, kind, { kind: 'local', definitionOrdinal: local.ordinal });
    } else if (imported) {
      add(node, kind, { kind: 'import', module: imported.module, importedName: imported.importedName });
    }
  };

  walk(root, (node) => {
    if (node.type !== 'call_expression' && node.type !== 'call') return;
    const callee = field(node, 'function');
    if (callee?.type === 'identifier') {
      handledCallIdentifiers.add(nodeKey(callee));
      directUse(callee, 'calls');
      return;
    }
    if (!callee) return;
    const property = propertyOf(callee);
    const local = property ? localTargets.get(property.text) : undefined;
    if (property && local && local !== null) {
      handledProperties.add(nodeKey(property));
      add(property, 'possible_textual_match', { kind: 'local', definitionOrdinal: local.ordinal });
    }
  });

  walk(root, (node) => {
    if (node.type !== 'identifier') return;
    if (handledCallIdentifiers.has(nodeKey(node)) || handledProperties.has(nodeKey(node))) return;
    if (isProperty(node)) {
      const local = localTargets.get(node.text);
      if (local && local !== null) add(node, 'possible_textual_match', { kind: 'local', definitionOrdinal: local.ordinal });
      return;
    }
    if (isValueReference(node, language)) directUse(node, 'references');
  });

  return usages.sort((a, b) =>
    a.span.start_line - b.span.start_line
    || a.span.start_col - b.span.start_col
    || a.kind.localeCompare(b.kind),
  );
}