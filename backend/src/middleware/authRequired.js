import { pool } from '../db.js';
import { verifyJwt } from '../auth.js';

const roleRank = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

async function authRequired(req, res, next) {
  const header = req.get('authorization') || '';
  const [, token] = header.match(/^Bearer\s+(.+)$/i) || [];

  if (!token) return res.status(401).json({ error: 'Missing access token' });

  try {
    const payload = verifyJwt(token, 'access');
    const result = await pool.query(
      'SELECT id, email, display_name, token_version FROM users WHERE id = $1',
      [payload.sub]
    );
    const user = result.rows[0];
    if (!user || user.token_version !== payload.tokenVersion) {
      return res.status(401).json({ error: 'Access token has been revoked' });
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: err.message || 'Invalid access token' });
  }
}

function requireDocumentRole(paramName, minimumRole) {
  return async (req, res, next) => {
    const documentId = req.params[paramName];
    try {
      const result = await pool.query(
        `SELECT role FROM document_members
          WHERE document_id = $1 AND user_id = $2`,
        [documentId, req.user.id]
      );
      const role = result.rows[0]?.role;
      if (!role || roleRank[role] < roleRank[minimumRole]) {
        return res.status(403).json({ error: 'Insufficient document permissions' });
      }
      req.documentRole = role;
      next();
    } catch (err) {
      console.error('[AUTH] document role check failed', err);
      res.status(500).json({ error: 'Failed to check document permissions' });
    }
  };
}

export { authRequired, requireDocumentRole, roleRank };
