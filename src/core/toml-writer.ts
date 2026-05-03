/**
 * Minimal TOML writer for the small subset brainclaw needs (Mistral Vibe MCP
 * config). Zero runtime dependency by policy. Supports:
 *   - inline tables `[name]`
 *   - array-of-tables `[[name]]`
 *   - string keys
 *   - string and string-array values
 *   - basic escaping for strings (`\` and `"` and control chars)
 *
 * Does NOT support: numbers, booleans, dates, nested tables, mixed-type arrays,
 * multi-line strings, comments. If you need any of those, reach for `@iarna/toml`
 * — but every brainclaw call site so far fits this subset.
 */

export type TomlScalar = string;
export type TomlValue = TomlScalar | TomlScalar[];

export interface TomlTable {
  [key: string]: TomlValue;
}

export interface TomlArrayOfTables {
  /** Section header — written as `[[name]]`. */
  name: string;
  /** Ordered entries; each becomes one `[[name]]` block. */
  entries: TomlTable[];
}

export interface TomlDocument {
  /** Top-level inline tables, written as `[name]` blocks. */
  tables?: Array<{ name: string; entries: TomlTable }>;
  /** Array-of-tables blocks. */
  arrayTables?: TomlArrayOfTables[];
}

/** Escape a string for a TOML basic string literal. */
export function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function renderValue(value: TomlValue): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => `"${escapeTomlString(v)}"`).join(', ');
    return `[${items}]`;
  }
  return `"${escapeTomlString(value)}"`;
}

function renderTable(name: string, entries: TomlTable, header: '[' | '[['): string {
  const close = header === '[[' ? ']]' : ']';
  const lines: string[] = [`${header}${name}${close}`];
  for (const [key, value] of Object.entries(entries)) {
    lines.push(`${key} = ${renderValue(value)}`);
  }
  return lines.join('\n');
}

/** Serialize a TomlDocument to a string. Tables come first, then array-of-tables. */
export function renderToml(doc: TomlDocument): string {
  const blocks: string[] = [];
  for (const table of doc.tables ?? []) {
    blocks.push(renderTable(table.name, table.entries, '['));
  }
  for (const arrayTable of doc.arrayTables ?? []) {
    for (const entry of arrayTable.entries) {
      blocks.push(renderTable(arrayTable.name, entry, '[['));
    }
  }
  return blocks.join('\n\n') + (blocks.length > 0 ? '\n' : '');
}

/**
 * Heuristic line-based check for "does this TOML already declare a
 * [[<sectionName>]] block whose `name = "<entryName>"` field matches?".
 * Used by writers to remain idempotent without a full TOML parser.
 *
 * Limitations: assumes the `name = "..."` field appears in the first ~10 lines
 * after the `[[sectionName]]` header (true for our writer's output and for
 * hand-written files that follow the convention `name` first).
 */
export function tomlArrayTableHasEntry(
  source: string,
  sectionName: string,
  entryNameValue: string,
): boolean {
  const headerPattern = new RegExp(String.raw`^\[\[\s*${escapeRegex(sectionName)}\s*\]\]\s*$`);
  const namePattern = new RegExp(String.raw`^name\s*=\s*"${escapeRegex(entryNameValue)}"\s*$`);
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (headerPattern.test(lines[i])) {
      // Look in the next ~10 lines (until next blank or next header) for `name = "<value>"`
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const line = lines[j].trim();
        if (line.startsWith('[')) break; // next section
        if (namePattern.test(line)) return true;
      }
    }
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
