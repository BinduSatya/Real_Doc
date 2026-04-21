import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import CollabEditor        from '../components/CollabEditor';
import { useCollaboration } from '../hooks/useCollaboration';

const API = '/api/documents';

export default function Document() {
  const { docId }  = useParams();
  const navigate   = useNavigate();

  // ── Document metadata ─────────────────────────────────────────────────────
  const [docMeta,    setDocMeta]    = useState(null);
  const [metaError,  setMetaError]  = useState(null);

  // ── Title editing ─────────────────────────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft,   setTitleDraft]   = useState('');
  const titleInputRef = useRef(null);

  // ── Collaboration (CRDT + WebSocket) ─────────────────────────────────────
  const {
    ydoc,
    provider,
    status,
    localUser,
    setUserName,
    awarenessUsers,
  } = useCollaboration(docId);

  // ── Load document metadata ────────────────────────────────────────────────
  useEffect(() => {
    if (!docId) return;
    fetch(`${API}/${docId}`)
      .then((r) => {
        if (r.status === 404) { navigate('/'); return null; }
        if (!r.ok) throw new Error('Failed to load');
        return r.json();
      })
      .then((data) => {
        if (data) {
          setDocMeta(data);
          setTitleDraft(data.title);
        }
      })
      .catch((e) => setMetaError(e.message));
  }, [docId, navigate]);

  // ── Focus title input when edit starts ───────────────────────────────────
  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select();
  }, [editingTitle]);

  // ── Save title ────────────────────────────────────────────────────────────
  const saveTitle = async () => {
    const trimmed = titleDraft.trim() || 'Untitled Document';
    setEditingTitle(false);
    if (trimmed === docMeta?.title) return;
    try {
      const res = await fetch(`${API}/${docId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ title: trimmed }),
      });
      if (res.ok) {
        const updated = await res.json();
        setDocMeta((prev) => ({ ...prev, title: updated.title }));
        setTitleDraft(updated.title);
      }
    } catch (_) {}
  };

  const handleTitleKey = (e) => {
    if (e.key === 'Enter')  saveTitle();
    if (e.key === 'Escape') { setEditingTitle(false); setTitleDraft(docMeta?.title || ''); }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (metaError) {
    return (
      <div className="doc-error">
        <p>⚠ {metaError}</p>
        <Link to="/">← Back to documents</Link>
      </div>
    );
  }

  return (
    <div className="doc-page">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <nav className="doc-nav">
        <Link to="/" className="doc-nav__back">
          <span>←</span> Docs
        </Link>

        {/* Inline-editable title */}
        <div className="doc-nav__title-wrap">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="doc-nav__title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={handleTitleKey}
              maxLength={120}
            />
          ) : (
            <h1
              className="doc-nav__title"
              onClick={() => setEditingTitle(true)}
              title="Click to rename"
            >
              {docMeta?.title || 'Loading…'}
              <span className="doc-nav__title-edit-icon">✎</span>
            </h1>
          )}
        </div>

        {/* User name editor */}
        <div className="doc-nav__user">
          <span
            className="user-chip"
            style={{ backgroundColor: localUser.color }}
            title="Click to change your display name"
            onClick={() => {
              const name = prompt('Your display name:', localUser.name);
              if (name?.trim()) setUserName(name.trim());
            }}
          >
            {localUser.name[0].toUpperCase()}
            <span className="user-chip__name">{localUser.name}</span>
          </span>
        </div>
      </nav>

      {/* ── Editor ──────────────────────────────────────────────────────── */}
      <div className="doc-editor-wrap">
        {ydoc && provider ? (
          <CollabEditor
            ydoc={ydoc}
            provider={provider}
            localUser={localUser}
            awarenessUsers={awarenessUsers}
            status={status}
          />
        ) : (
          <div className="doc-loading">
            <div className="spinner" />
            <p>Connecting to document…</p>
          </div>
        )}
      </div>
    </div>
  );
}
