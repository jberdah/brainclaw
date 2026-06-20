import type { User } from './types.js';

export function formatUserName(user: User): string {
  return user.name.trim() || user.email;
}

export function capitalize(value: string): string {
  if (!value) return value;
  return value[0]!.toUpperCase() + value.slice(1);
}

export function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
