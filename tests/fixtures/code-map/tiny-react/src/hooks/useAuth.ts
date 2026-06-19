import { useCallback, useEffect, useState } from 'react';
import type { AuthStatus, Session } from '../util/types.js';
import { login as apiLogin, fetchUser } from '../util/http.js';
import { clearToken, loadToken, saveToken } from '../util/storage.js';

export function useAuth() {
  const [session, setSession] = useState<Session>({ user: null, token: null });
  const [status, setStatus] = useState<AuthStatus>('anonymous');

  useEffect(() => {
    const token = loadToken();
    if (!token) return;
    fetchUser(token)
      .then((user) => {
        setSession({ user, token });
        setStatus('authenticated');
      })
      .catch(() => setStatus('expired'));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const next = await apiLogin(email, password);
    if (next.token) saveToken(next.token);
    setSession(next);
    setStatus(next.user ? 'authenticated' : 'anonymous');
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setSession({ user: null, token: null });
    setStatus('anonymous');
  }, []);

  return { session, status, signIn, signOut };
}
