import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiFetch } from '../api';
import { useAuth } from '../auth/AuthContext';

const API = '/api/documents';

function formatDate(iso) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export default function Home() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const fetchDocs = useCallback(async () => {
    try {
      const res = await apiFetch(API);
      if (!res.ok) throw new Error('Failed to load documents');
      setDocs(await res.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDocs();
    const id = setInterval(fetchDocs, 5000);
    return () => clearInterval(id);
  }, [fetchDocs]);

  const createDoc = async () => {
    setCreating(true);
    try {
      const res = await apiFetch(API, {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled Document' }),
      });
      if (!res.ok) throw new Error('Failed to create document');
      const doc = await res.json();
      navigate(`/doc/${doc.id}`);
    } catch (e) {
      setError(e.message);
      setCreating(false);
    }
  };

  const deleteDoc = async (e, doc) => {
    e.stopPropagation();
    if (doc.role !== 'owner') return;
    if (!confirm('Delete this document? This cannot be undone.')) return;
    await apiFetch(`${API}/${doc.id}`, { method: 'DELETE' });
    setDocs((prev) => prev.filter((d) => d.id !== doc.id));
  };

  return (
    <div className="home-page">
      <aside className="home-sidebar">
        <div className="brand">
          <span className="brand-icon">*</span>
          <span className="brand-name">RealDoc</span>
        </div>
        <p className="brand-tagline">Secure real-time documents,<br />powered by CRDT.</p>
      </aside>

      <main className="home-main">
        <header className="home-header">
          <div>
            <h1 className="home-title">Your Documents</h1>
            <p className="home-user">{user?.displayName}</p>
          </div>
          <div className="home-actions">
            <button className="btn btn--ghost" onClick={logout}>Logout</button>
            <button className="btn btn--primary" onClick={createDoc} disabled={creating}>
              {creating ? 'Creating...' : '+ New Document'}
            </button>
          </div>
        </header>

        {error && (
          <div className="alert alert--error">
            {error} <button onClick={fetchDocs}>Retry</button>
          </div>
        )}

        {loading ? (
          <div className="doc-grid-loading">
            {[1, 2, 3].map((n) => (
              <div key={n} className="doc-card doc-card--skeleton" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <div className="empty-state">
            <p className="empty-icon">Document</p>
            <p className="empty-text">No documents yet.</p>
            <button className="btn btn--primary" onClick={createDoc}>
              Create your first document
            </button>
          </div>
        ) : (
          <div className="doc-grid">
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="doc-card"
                onClick={() => navigate(`/doc/${doc.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/doc/${doc.id}`)}
              >
                <div className="doc-card__preview">
                  <span className="doc-card__initial">
                    {(doc.title || 'U')[0].toUpperCase()}
                  </span>
                </div>
                <div className="doc-card__meta">
                  <h2 className="doc-card__title">{doc.title || 'Untitled'}</h2>
                  <p className="doc-card__date">{formatDate(doc.updated_at)}</p>
                  <span className={`role-pill role-pill--${doc.role}`}>{doc.role}</span>
                  {doc.active_users > 0 && (
                    <span className="doc-card__live">
                      <span className="pulse-dot" />
                      {doc.active_users} editing
                    </span>
                  )}
                </div>
                <button
                  className="doc-card__delete"
                  onClick={(e) => deleteDoc(e, doc)}
                  title="Delete document"
                  disabled={doc.role !== 'owner'}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
