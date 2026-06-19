// §10: simple fn / class / type / interface (all non-exported + exported mix).
interface UserShape {
  id: number;
}

export interface AdminShape {
  level: number;
}

type UserId = number;

export type AdminId = string;

class InternalStore {
  get(): number {
    return 1;
  }
}

export class PublicStore {
  put(): void {}
}

function helper(a: number): number {
  return a;
}

export function compute(a: number, b: number): number {
  return a + b;
}
