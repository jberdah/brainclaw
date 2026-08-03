# Store shape fixtures (pln#619)

Field-shape summaries of a real dogfood brainclaw store: field names, value
types, presence ratios — and observed values for an ALLOWLIST of enum-like
fields only (status, type, severity, …). Free text, identity values and ids
are never exported, whatever their length — raw-value corpora stay inside
the private snapshot (`store-snapshot.mjs create`).

Regenerate: `node scripts/store-snapshot.mjs fixtures --store <store> --out <dir>`
