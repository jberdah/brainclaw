# Store shape fixtures (pln#619)

Field-shape summaries of a real dogfood brainclaw store: field names, value
types, presence ratios, and observed SHORT values (status enums, schema
versions). No free text and no ids are ever exported — raw-value corpora
stay inside the private snapshot (`store-snapshot.mjs create`).

Regenerate: `node scripts/store-snapshot.mjs fixtures --store <store> --out <dir>`
