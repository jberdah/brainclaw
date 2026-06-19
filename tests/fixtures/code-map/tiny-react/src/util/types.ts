export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Session {
  user: User | null;
  token: string | null;
}

export type AuthStatus = 'anonymous' | 'authenticated' | 'expired';

export type Role = 'admin' | 'editor' | 'viewer';
