// §10: `export { a }` BEFORE the declaration — at the clause site no symbol
// exists yet, so legacy fabricates an `export` symbol; the later declaration
// adds its own symbol independently (documents the legacy hoisting behavior).
export { gamma, delta };

function gamma(): void {}

const delta = 4;
