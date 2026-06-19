// §10: `export { a }` AFTER the declaration — the clause marks the existing
// symbol exported and emits an exports edge.
function alpha(): void {}

const beta = 2;

export { alpha, beta };
