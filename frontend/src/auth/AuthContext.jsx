import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { apiFetch, isAccessTokenFresh, refreshAccessToken, setAccessToken, userFromAccessToken } from '../api';

const AuthContext = createContext(null);

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function bootSession() {
      const localUser = userFromAccessToken();
      if (localUser && isAccessTokenFresh()) {
        setUser(localUser);
        setBooting(false);

        const res = await apiFetch('/api/auth/me', {}, false).catch(() => null);
        if (!cancelled && res?.ok) {
          const data = await res.json();
          setUser(data.user);
        }
        return;
      }

      refreshAccessToken()
        .then((data) => !cancelled && setUser(data.user))
        .catch(() => !cancelled && setUser(null))
        .finally(() => !cancelled && setBooting(false));
    }

    bootSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const id = setInterval(() => {
      refreshAccessToken()
        .then((data) => setUser(data.user))
        .catch(() => setUser(null));
    }, 14 * 60 * 1000);
    return () => clearInterval(id);
  }, [user]);

  const login = useCallback(async ({ mode, email, password, displayName }) => {
    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password, displayName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Authentication failed');
    setAccessToken(data.accessToken);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAccessToken('');
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, booting, login, logout }), [user, booting, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export { AuthProvider, useAuth };
