export const ENTITY_REGISTRY = new Map<string, string>();

export function resolveEntity(name: string): string | undefined {
  return ENTITY_REGISTRY.get(name);
}
