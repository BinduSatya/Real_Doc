-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL DEFAULT 'Untitled Document',
  ydoc_state  BYTEA,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Version history
CREATE TABLE IF NOT EXISTS document_snapshots (
  id          SERIAL      PRIMARY KEY,
  document_id UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ydoc_state  BYTEA       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- Seed a demo document
INSERT INTO documents (id, title)
VALUES ('00000000-0000-0000-0000-000000000001', 'Welcome Document')
ON CONFLICT DO NOTHING;
