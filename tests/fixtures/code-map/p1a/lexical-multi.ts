// §10: lexical multi-declarator — every declarator shares the enclosing
// declaration statement span (const a=1,b=2).
const a = 1,
  b = 2,
  c = 3;

export const d = 10,
  e = 20;

let mutableX = 1,
  mutableY = 2;
