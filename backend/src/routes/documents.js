import express from 'express';
import { v4 as uuidv4 } from 'uuid';

import { pool } from '../db.js';
import { getActiveUserCount } from '../yjsManager.js';

const router = express.Router();

// GET /api/documents — list all documents
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, created_at, updated_at FROM documents ORDER BY updated_at DESC'
    );
    const rows = result.rows.map((row) => ({
      ...row,
      active_users: getActiveUserCount(row.id),
    }));
    res.json(rows);
  } catch (err) {
    console.error('[REST] GET /documents', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// POST /api/documents — create a new document
router.post('/', async (req, res) => {
  const { title = 'Untitled Document' } = req.body ?? {};
  try {
    const result = await pool.query(
      'INSERT INTO documents (id, title) VALUES ($1, $2) RETURNING id, title, created_at, updated_at',
      [uuidv4(), title]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[REST] POST /documents', err);
    res.status(500).json({ error: 'Failed to create document' });
  }
});

// GET /api/documents/:id — single document metadata
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, created_at, updated_at FROM documents WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const doc = result.rows[0];
    doc.active_users = getActiveUserCount(doc.id);
    res.json(doc);
  } catch (err) {
    console.error('[REST] GET /documents/:id', err);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// PATCH /api/documents/:id — update title
router.patch('/:id', async (req, res) => {
  const { title } = req.body ?? {};
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  try {
    const result = await pool.query(
      'UPDATE documents SET title = $1 WHERE id = $2 RETURNING id, title, updated_at',
      [title.trim(), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[REST] PATCH /documents/:id', err);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// DELETE /api/documents/:id — delete document
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error('[REST] DELETE /documents/:id', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// GET /api/documents/:id/snapshots — list snapshots
router.get('/:id/snapshots', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, created_at FROM document_snapshots
        WHERE document_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[REST] GET /documents/:id/snapshots', err);
    res.status(500).json({ error: 'Failed to fetch snapshots' });
  }
});

export default router;
