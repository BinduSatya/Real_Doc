-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users and auth
CREATE TABLE IF NOT EXISTS users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT        NOT NULL,
  password_hash  TEXT        NOT NULL,
  display_name   TEXT        NOT NULL,
  token_version  INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash            TEXT        NOT NULL UNIQUE,
  family_id             UUID        NOT NULL,
  parent_token_id       UUID        REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  replaced_by_token_id  UUID        REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  version               INTEGER     NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  reuse_detected_at     TIMESTAMPTZ,
  last_used_at          TIMESTAMPTZ,
  user_agent            TEXT,
  ip_address            INET,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL DEFAULT 'Untitled Document',
  ydoc_state  BYTEA,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_members (
  document_id UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS document_members_user_idx ON document_members(user_id);

-- Version history
CREATE TABLE IF NOT EXISTS document_snapshots (
  id             SERIAL      PRIMARY KEY,
  document_id    UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number INTEGER     NOT NULL,
  ydoc_state     BYTEA       NOT NULL,
  created_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  label          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version_number)
);

ALTER TABLE document_snapshots
  ADD COLUMN IF NOT EXISTS version_number INTEGER,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS label TEXT;

WITH numbered_snapshots AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY created_at, id) AS version_number
    FROM document_snapshots
   WHERE version_number IS NULL
)
UPDATE document_snapshots s
   SET version_number = n.version_number
  FROM numbered_snapshots n
 WHERE s.id = n.id;

ALTER TABLE document_snapshots
  ALTER COLUMN version_number SET NOT NULL;

CREATE INDEX IF NOT EXISTS document_snapshots_doc_idx
  ON document_snapshots(document_id, version_number DESC);
CREATE UNIQUE INDEX IF NOT EXISTS document_snapshots_doc_version_idx
  ON document_snapshots(document_id, version_number);

CREATE TABLE IF NOT EXISTS document_comments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anchor_from   INTEGER     NOT NULL,
  anchor_to     INTEGER     NOT NULL,
  selected_text TEXT        NOT NULL,
  body          TEXT        NOT NULL,
  resolved      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS document_comments_doc_idx ON document_comments(document_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_updated_at ON documents;
CREATE TRIGGER documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS document_members_updated_at ON document_members;
CREATE TRIGGER document_members_updated_at
  BEFORE UPDATE ON document_members
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS document_comments_updated_at ON document_comments;
CREATE TRIGGER document_comments_updated_at
  BEFORE UPDATE ON document_comments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Seed a demo document
INSERT INTO documents (id, title)
VALUES ('00000000-0000-0000-0000-000000000001', 'Welcome Document')
ON CONFLICT DO NOTHING;
