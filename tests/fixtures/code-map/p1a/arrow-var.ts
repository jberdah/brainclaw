// §10: arrow / var declarations classified as function vs variable.
const addArrow = (x: number, y: number): number => x + y;

export const multiplyArrow = (x: number, y: number): number => x * y;

const plainValue = 42;

var legacyVar = 'old';

const fnExpr = function namedExpr(z: number): number {
  return z;
};
