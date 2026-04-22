let accessToken = localStorage.getItem('access-token') || '';

function decodeJwtPayload(token) {
  try {
    let payload = token.split('.')[1];
    if (!payload) return null;
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    payload = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    return JSON.parse(atob(payload));
  } catch (_) {
    return null;
  }
}

function getAccessToken() {
  return accessToken;
}

function getAccessTokenPayload() {
  return decodeJwtPayload(accessToken);
}

function isAccessTokenFresh(skewSeconds = 20) {
  const payload = getAccessTokenPayload();
  if (!payload?.exp) return false;
  return payload.exp > Math.floor(Date.now() / 1000) + skewSeconds;
}

function userFromAccessToken() {
  const payload = getAccessTokenPayload();
  if (!payload?.sub || !isAccessTokenFresh(0)) return null;
  return {
    id: payload.sub,
    email: payload.email,
    displayName: payload.name,
  };
}

function setAccessToken(token) {
  accessToken = token || '';
  if (accessToken) localStorage.setItem('access-token', accessToken);
  else localStorage.removeItem('access-token');
}

async function refreshAccessToken() {
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    setAccessToken('');
    throw new Error('Session expired');
  }
  const data = await res.json();
  setAccessToken(data.accessToken);
  return data;
}

async function apiFetch(url, options = {}, retry = true) {
  const headers = new Headers(options.headers || {});
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401 && retry) {
    await refreshAccessToken();
    return apiFetch(url, options, false);
  }

  return res;
}

export {
  apiFetch,
  getAccessToken,
  getAccessTokenPayload,
  isAccessTokenFresh,
  refreshAccessToken,
  setAccessToken,
  userFromAccessToken,
};
