import express from 'express';
import crypto from 'node:crypto';

import { pool } from '../db.js';
import {
  clearRefreshCookie,
  createAccessToken,
  createRefreshToken,
  getRefreshCookie,
  hashPassword,
  hashToken,
  publicUser,
  revokeRefreshFamily,
  setRefreshCookie,
  verifyJwt,
  verifyPassword,
} from '../auth.js';
import { authRequired } from '../middleware/authRequired.js';

const router = express.Router();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateAuthBody(req, res) {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email is required' });
    return null;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return null;
  }
  return { email, password };
}

async function issueLogin(res, req, user) {
  const familyId = crypto.randomUUID();
  const refresh = await createRefreshToken({
    user,
    familyId,
    parentTokenId: null,
    version: 1,
    req,
  });
  const accessToken = createAccessToken(user);
  setRefreshCookie(res, refresh.token);
  res.json({ accessToken, user: publicUser(user) });
}

router.post('/signup', async (req, res) => {
  const body = validateAuthBody(req, res);
  if (!body) return;

  const displayName = String(req.body?.displayName || body.email.split('@')[0]).trim();

  try {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, token_version`,
      [body.email, hashPassword(body.password), displayName || body.email]
    );
    await issueLogin(res, req, result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email is already registered' });
    console.error('[AUTH] signup failed', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.post('/login', async (req, res) => {
  const body = validateAuthBody(req, res);
  if (!body) return;

  try {
    const result = await pool.query(
      'SELECT id, email, display_name, password_hash, token_version FROM users WHERE LOWER(email) = $1',
      [body.email]
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    await issueLogin(res, req, user);
  } catch (err) {
    console.error('[AUTH] login failed', err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

router.post('/refresh', async (req, res) => {
  const token = getRefreshCookie(req);
  if (!token) return res.status(401).json({ error: 'Missing refresh token' });

  const client = await pool.connect();
  try {
    const payload = verifyJwt(token, 'refresh');
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT id, email, display_name, token_version FROM users WHERE id = $1 FOR UPDATE',
      [payload.sub]
    );
    const user = userResult.rows[0];
    if (!user || user.token_version !== payload.tokenVersion) {
      await client.query('ROLLBACK');
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Refresh token has been revoked' });
    }

    const tokenResult = await client.query(
      'SELECT * FROM refresh_tokens WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [payload.jti, user.id]
    );
    const row = tokenResult.rows[0];
    const tokenMatches = row && row.token_hash === hashToken(token);
    const tokenExpired = row && new Date(row.expires_at).getTime() <= Date.now();
    const tokenReused = row && (row.revoked_at || row.replaced_by_token_id);

    if (!row || !tokenMatches || tokenExpired || tokenReused) {
      await revokeRefreshFamily(client, payload.familyId, payload.sub, true);
      await client.query('COMMIT');
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Refresh token reuse detected. Session invalidated.' });
    }

    await client.query('UPDATE refresh_tokens SET last_used_at = NOW(), revoked_at = NOW() WHERE id = $1', [row.id]);
    const nextRefresh = await createRefreshToken({
      user,
      familyId: row.family_id,
      parentTokenId: row.id,
      version: row.version + 1,
      req,
      client,
    });
    await client.query(
      'UPDATE refresh_tokens SET replaced_by_token_id = $1 WHERE id = $2',
      [nextRefresh.tokenId, row.id]
    );

    await client.query('COMMIT');
    setRefreshCookie(res, nextRefresh.token);
    res.json({ accessToken: createAccessToken(user), user: publicUser(user) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    clearRefreshCookie(res);
    res.status(401).json({ error: err.message || 'Invalid refresh token' });
  } finally {
    client.release();
  }
});

router.post('/logout', async (req, res) => {
  const token = getRefreshCookie(req);
  if (token) {
    try {
      const payload = verifyJwt(token, 'refresh');
      await pool.query(
        'UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1 AND user_id = $2',
        [payload.jti, payload.sub]
      );
    } catch (_) {}
  }
  clearRefreshCookie(res);
  res.status(204).send();
});

router.get('/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

export default router;
