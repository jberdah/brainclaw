import type { Session, User } from './types.js';

export async function fetchUser(token: string): Promise<User> {
  const res = await fetch('/api/me', { headers: { authorization: token } });
  return (await res.json()) as User;
}

export async function login(email: string, password: string): Promise<Session> {
  const res = await fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return (await res.json()) as Session;
}

export const API_BASE = '/api';
