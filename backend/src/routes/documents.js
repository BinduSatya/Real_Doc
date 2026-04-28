import express from "express";
import { v4 as uuidv4 } from "uuid";

import { pool } from "../db.js";
import {
  getActiveUserCount,
  getCurrentState,
  replaceDocumentState,
} from "../yjsManager.js";
import {
  authRequired,
  requireDocumentRole,
} from "../middleware/authRequired.js";

const router = express.Router();

router.use(authRequired);

function statesEqual(left, right) {
  if (!left || !right) return false;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

// GET /api/documents - list documents visible to the current user
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.id, d.title, d.created_at, d.updated_at, dm.role
         FROM documents d
         JOIN document_members dm ON dm.document_id = d.id
        WHERE dm.user_id = $1
        ORDER BY d.updated_at DESC`,
      [req.user.id],
    );
    const rows = result.rows.map((row) => ({
      ...row,
      active_users: getActiveUserCount(row.id),
    }));
    res.json(rows);
  } catch (err) {
    console.error("[REST] GET /documents", err);
    res.status(500).json({ error: "Failed to fetch documents" });
  }
});

// POST /api/documents - create a new document owned by the current user
router.post("/", async (req, res) => {
  const { title = "Untitled Document" } = req.body ?? {};
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const docId = uuidv4();
    const docResult = await client.query(
      "INSERT INTO documents (id, title) VALUES ($1, $2) RETURNING id, title, created_at, updated_at",
      [docId, title],
    );
    await client.query(
      "INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, $3)",
      [docId, req.user.id, "owner"],
    );
    await client.query("COMMIT");
    res.status(201).json({ ...docResult.rows[0], role: "owner" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[REST] POST /documents", err);
    res.status(500).json({ error: "Failed to create document" });
  } finally {
    client.release();
  }
});

// GET /api/documents/:id - single document metadata
router.get("/:id", requireDocumentRole("id", "viewer"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, title, created_at, updated_at FROM documents WHERE id = $1",
      [req.params.id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Not found" });
    const doc = result.rows[0];
    doc.active_users = getActiveUserCount(doc.id);
    doc.role = req.documentRole;
    res.json(doc);
  } catch (err) {
    console.error("[REST] GET /documents/:id", err);
    res.status(500).json({ error: "Failed to fetch document" });
  }
});

// PATCH /api/documents/:id - update title
router.patch("/:id", requireDocumentRole("id", "editor"), async (req, res) => {
  const { title } = req.body ?? {};
  if (!title?.trim())
    return res.status(400).json({ error: "title is required" });
  try {
    const result = await pool.query(
      "UPDATE documents SET title = $1 WHERE id = $2 RETURNING id, title, updated_at",
      [title.trim(), req.params.id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Not found" });
    res.json({ ...result.rows[0], role: req.documentRole });
  } catch (err) {
    console.error("[REST] PATCH /documents/:id", err);
    res.status(500).json({ error: "Failed to update document" });
  }
});

// DELETE /api/documents/:id - delete document
router.delete("/:id", requireDocumentRole("id", "owner"), async (req, res) => {
  try {
    await pool.query("DELETE FROM documents WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error("[REST] DELETE /documents/:id", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

// GET /api/documents/:id/snapshots - list document versions
router.get(
  "/:id/snapshots",
  requireDocumentRole("id", "viewer"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT s.id, s.version_number, s.label, s.created_at, u.display_name AS created_by
         FROM document_snapshots s
         LEFT JOIN users u ON u.id = s.created_by
        WHERE s.document_id = $1
        ORDER BY s.version_number DESC
        LIMIT 40`,
        [req.params.id],
      );
      res.json(result.rows);
    } catch (err) {
      console.error("[REST] GET /documents/:id/snapshots", err);
      res.status(500).json({ error: "Failed to fetch snapshots" });
    }
  },
);

// POST /api/documents/:id/snapshots - create a manual snapshot (immediate)
router.post(
  "/:id/snapshots",
  requireDocumentRole("id", "editor"),
  async (req, res) => {
    try {
      const state = await getCurrentState(req.params.id);
      if (!state)
        return res.status(404).json({ error: "Document state not found" });

      const label = String(req.body?.label || "Manual save");
      const result = await pool.query(
        `INSERT INTO document_snapshots (document_id, version_number, ydoc_state, created_by, label)
       SELECT $1, COALESCE(MAX(version_number), 0) + 1, $2, $3, $4
         FROM document_snapshots
        WHERE document_id = $1
       RETURNING id, version_number, created_at, label`,
        [req.params.id, state, req.user.id, label],
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("[REST] POST /documents/:id/snapshots", err);
      res.status(500).json({ error: "Failed to create snapshot" });
    }
  },
);

// POST /api/documents/:id/snapshots/:snapshotId/restore - rollback to a saved version
router.post(
  "/:id/snapshots/:snapshotId/restore",
  requireDocumentRole("id", "editor"),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const currentState = await getCurrentState(req.params.id);
      const snapshotResult = await client.query(
        `SELECT id, version_number, ydoc_state
         FROM document_snapshots
        WHERE id = $1 AND document_id = $2`,
        [req.params.snapshotId, req.params.id],
      );
      const snapshot = snapshotResult.rows[0];
      if (!snapshot) {
        return res.status(404).json({ error: "Version not found" });
      }

      if (statesEqual(currentState, snapshot.ydoc_state)) {
        return res.json({
          restoredFromVersion: snapshot.version_number,
          backupCreated: false,
          restoredSnapshotCreated: false,
          message: `Document is already at v${snapshot.version_number}`,
        });
      }

      const latestSnapshotResult = await client.query(
        `SELECT id, version_number, ydoc_state
         FROM document_snapshots
        WHERE document_id = $1
        ORDER BY version_number DESC
        LIMIT 1`,
        [req.params.id],
      );
      const latestSnapshot = latestSnapshotResult.rows[0];
      const hasUnsavedChanges =
        currentState && !statesEqual(currentState, latestSnapshot?.ydoc_state);
      let backupCreated = false;

      await client.query("BEGIN");

      if (hasUnsavedChanges) {
        await client.query(
          `INSERT INTO document_snapshots (document_id, version_number, ydoc_state, created_by, label)
         SELECT $1, COALESCE(MAX(version_number), 0) + 1, $2, $3, $4
           FROM document_snapshots
          WHERE document_id = $1`,
          [
            req.params.id,
            currentState,
            req.user.id,
            `Before restore to v${snapshot.version_number}`,
          ],
        );
        backupCreated = true;
      }

      await client.query(
        `INSERT INTO document_snapshots (document_id, version_number, ydoc_state, created_by, label)
       SELECT $1, COALESCE(MAX(version_number), 0) + 1, $2, $3, $4
         FROM document_snapshots
        WHERE document_id = $1
       RETURNING id, version_number, created_at`,
        [
          req.params.id,
          snapshot.ydoc_state,
          req.user.id,
          `Restored from v${snapshot.version_number}`,
        ],
      );

      await client.query("COMMIT");
      await replaceDocumentState(req.params.id, snapshot.ydoc_state);

      res.json({
        restoredFromVersion: snapshot.version_number,
        backupCreated,
        restoredSnapshotCreated: true,
        message: `Restored document to v${snapshot.version_number}`,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(
        "[REST] POST /documents/:id/snapshots/:snapshotId/restore",
        err,
      );
      res.status(500).json({ error: "Failed to restore version" });
    } finally {
      client.release();
    }
  },
);

// GET /api/documents/:id/members - list collaborators
router.get(
  "/:id/members",
  requireDocumentRole("id", "viewer"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT u.id, u.email, u.display_name, dm.role, dm.created_at
         FROM document_members dm
         JOIN users u ON u.id = dm.user_id
        WHERE dm.document_id = $1
        ORDER BY CASE dm.role WHEN 'owner' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, u.display_name`,
        [req.params.id],
      );
      res.json(result.rows);
    } catch (err) {
      console.error("[REST] GET /documents/:id/members", err);
      res.status(500).json({ error: "Failed to fetch members" });
    }
  },
);

// POST /api/documents/:id/members - add or update a collaborator by email
router.post(
  "/:id/members",
  requireDocumentRole("id", "owner"),
  async (req, res) => {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const role = String(req.body?.role || "viewer");
    if (!email || !["viewer", "editor", "owner"].includes(role)) {
      return res
        .status(400)
        .json({ error: "Valid email and role are required" });
    }

    try {
      const userResult = await pool.query(
        "SELECT id, email, display_name FROM users WHERE LOWER(email) = $1",
        [email],
      );
      const user = userResult.rows[0];
      if (!user)
        return res
          .status(404)
          .json({ error: "No registered user with that email" });

      const result = await pool.query(
        `INSERT INTO document_members (document_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id)
       DO UPDATE SET role = EXCLUDED.role
       RETURNING role`,
        [req.params.id, user.id, role],
      );
      res.status(201).json({ ...user, role: result.rows[0].role });
    } catch (err) {
      console.error("[REST] POST /documents/:id/members", err);
      res.status(500).json({ error: "Failed to save member" });
    }
  },
);

// GET /api/documents/:id/comments - list comments
router.get(
  "/:id/comments",
  requireDocumentRole("id", "viewer"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT c.id, c.anchor_from, c.anchor_to, c.selected_text, c.body, c.resolved,
              c.created_at, c.updated_at, u.display_name AS author_name
         FROM document_comments c
         JOIN users u ON u.id = c.author_id
        WHERE c.document_id = $1
        ORDER BY c.created_at DESC`,
        [req.params.id],
      );
      res.json(result.rows);
    } catch (err) {
      console.error("[REST] GET /documents/:id/comments", err);
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  },
);

// POST /api/documents/:id/comments - comment on selected text
router.post(
  "/:id/comments",
  requireDocumentRole("id", "viewer"),
  async (req, res) => {
    const anchorFrom = Number(req.body?.anchorFrom);
    const anchorTo = Number(req.body?.anchorTo);
    const selectedText = String(req.body?.selectedText || "").trim();
    const body = String(req.body?.body || "").trim();

    if (
      !Number.isFinite(anchorFrom) ||
      !Number.isFinite(anchorTo) ||
      anchorTo <= anchorFrom ||
      !selectedText ||
      !body
    ) {
      return res
        .status(400)
        .json({ error: "Selected text and comment body are required" });
    }

    try {
      const result = await pool.query(
        `INSERT INTO document_comments
        (document_id, author_id, anchor_from, anchor_to, selected_text, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, anchor_from, anchor_to, selected_text, body, resolved, created_at, updated_at`,
        [req.params.id, req.user.id, anchorFrom, anchorTo, selectedText, body],
      );
      res
        .status(201)
        .json({ ...result.rows[0], author_name: req.user.display_name });
    } catch (err) {
      console.error("[REST] POST /documents/:id/comments", err);
      res.status(500).json({ error: "Failed to add comment" });
    }
  },
);

// PATCH /api/documents/:id/comments/:commentId - resolve/unresolve a comment
router.patch(
  "/:id/comments/:commentId",
  requireDocumentRole("id", "editor"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE document_comments
          SET resolved = COALESCE($1, resolved)
        WHERE id = $2 AND document_id = $3
        RETURNING id, resolved, updated_at`,
        [req.body?.resolved, req.params.commentId, req.params.id],
      );
      if (!result.rows.length)
        return res.status(404).json({ error: "Comment not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("[REST] PATCH /documents/:id/comments/:commentId", err);
      res.status(500).json({ error: "Failed to update comment" });
    }
  },
);

export default router;
