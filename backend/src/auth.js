import crypto from 'node:crypto';

import { pool } from './db.js';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PASSWORD_ITERATIONS = 210000;

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(data) {
  return crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
}

function createJwt(payload, expiresInSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`;
  return `${unsigned}.${sign(unsigned)}`;
}

function verifyJwt(token, expectedType) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');

  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  if (
    Buffer.byteLength(signature) !== Buffer.byteLength(expected) ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new Error('Invalid token signature');
  }

  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (expectedType && data.type !== expectedType) throw new Error('Invalid token type');
  if (data.exp && data.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return data;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256');
  return `pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${derived.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  const [scheme, iterations, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2' || !iterations || !salt || !hash) return false;
  const derived = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, 'sha256');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(derived.toString('base64url')));
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
  };
}

function createAccessToken(user) {
  return createJwt({
    type: 'access',
    sub: user.id,
    email: user.email,
    name: user.display_name,
    tokenVersion: user.token_version,
  }, ACCESS_TOKEN_TTL_SECONDS);
}

function createRefreshJwt({ user, tokenId, familyId, version, parentTokenId }) {
  return createJwt({
    type: 'refresh',
    sub: user.id,
    jti: tokenId,
    familyId,
    version,
    prev: parentTokenId || null,
    tokenVersion: user.token_version,
  }, REFRESH_TOKEN_TTL_SECONDS);
}

async function createRefreshToken({ user, familyId, parentTokenId, version, req, client = pool }) {
  const tokenId = crypto.randomUUID();
  const token = createRefreshJwt({ user, tokenId, familyId, version, parentTokenId });
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

  await client.query(
    `INSERT INTO refresh_tokens
      (id, user_id, token_hash, family_id, parent_token_id, version, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, '')::inet)`,
    [
      tokenId,
      user.id,
      hashToken(token),
      familyId,
      parentTokenId,
      version,
      expiresAt,
      req.get('user-agent') || null,
      req.ip?.replace('::ffff:', '') || '',
    ]
  );

  return { token, tokenId };
}

function getRefreshCookie(req) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === 'refresh_token') return decodeURIComponent(valueParts.join('='));
  }
  return null;
}

function setRefreshCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  res.cookie('refresh_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
    path: '/api/auth',
  });
}

function clearRefreshCookie(res) {
  res.clearCookie('refresh_token', { path: '/api/auth' });
}

async function revokeRefreshFamily(client, familyId, userId, markReuse = false) {
  await client.query(
    `UPDATE refresh_tokens
       SET revoked_at = COALESCE(revoked_at, NOW()),
           reuse_detected_at = CASE WHEN $3 THEN COALESCE(reuse_detected_at, NOW()) ELSE reuse_detected_at END
     WHERE family_id = $1 AND user_id = $2`,
    [familyId, userId, markReuse]
  );
  if (markReuse) {
    await client.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
  }
}

export {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
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
};
