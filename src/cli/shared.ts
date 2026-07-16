// pln#622 PR5 — helpers shared across CLI register modules.

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
