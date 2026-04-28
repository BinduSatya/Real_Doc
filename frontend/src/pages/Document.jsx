import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";

import { apiFetch } from "../api";
import { useAuth } from "../auth/AuthContext";
import CollabEditor from "../components/CollabEditor";
import { useCollaboration } from "../hooks/useCollaboration";

const API = "/api/documents";

export default function Document() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [docMeta, setDocMeta] = useState(null);
  const [metaError, setMetaError] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [members, setMembers] = useState([]);
  const [comments, setComments] = useState([]);
  const [versions, setVersions] = useState([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const [exportAction, setExportAction] = useState(null);
  const [restoringVersion, setRestoringVersion] = useState(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const titleInputRef = useRef(null);

  const { ydoc, provider, status, localUser, setUserName, awarenessUsers } =
    useCollaboration(docId, user);
  const canEdit = docMeta?.role === "owner" || docMeta?.role === "editor";
  const canOwn = docMeta?.role === "owner";

  const loadPanelData = useCallback(async () => {
    if (!docId) return;
    const [membersRes, commentsRes, versionsRes] = await Promise.all([
      apiFetch(`${API}/${docId}/members`),
      apiFetch(`${API}/${docId}/comments`),
      apiFetch(`${API}/${docId}/snapshots`),
    ]);
    if (membersRes.ok) setMembers(await membersRes.json());
    if (commentsRes.ok) setComments(await commentsRes.json());
    if (versionsRes.ok) setVersions(await versionsRes.json());
  }, [docId]);

  useEffect(() => {
    if (!docId) return;
    apiFetch(`${API}/${docId}`)
      .then((r) => {
        if (r.status === 404 || r.status === 403) {
          navigate("/");
          return null;
        }
        if (!r.ok) throw new Error("Failed to load document");
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

  useEffect(() => {
    loadPanelData().catch(() => {});
  }, [loadPanelData]);

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select();
  }, [editingTitle]);

  useEffect(() => {
    setNameDraft(localUser.name);
  }, [localUser.name]);

  const saveTitle = async () => {
    const trimmed = titleDraft.trim() || "Untitled Document";
    setEditingTitle(false);
    if (!canEdit || trimmed === docMeta?.title) return;
    const res = await apiFetch(`${API}/${docId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: trimmed }),
    });
    if (res.ok) {
      const updated = await res.json();
      setDocMeta((prev) => ({ ...prev, title: updated.title }));
      setTitleDraft(updated.title);
    }
  };

  const addComment = async (comment) => {
    const res = await apiFetch(`${API}/${docId}/comments`, {
      method: "POST",
      body: JSON.stringify(comment),
    });
    if (res.ok) {
      const created = await res.json();
      setComments((prev) => [created, ...prev]);
    }
  };

  const resolveComment = async (commentId, resolved) => {
    const res = await apiFetch(`${API}/${docId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ resolved }),
    });
    if (res.ok) {
      setComments((prev) =>
        prev.map((c) => (c.id === commentId ? { ...c, resolved } : c)),
      );
    }
  };

  const inviteMember = async (event) => {
    event.preventDefault();
    setShareMessage("");
    const res = await apiFetch(`${API}/${docId}/members`, {
      method: "POST",
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    if (res.ok) {
      const member = await res.json();
      setMembers((prev) => [member, ...prev.filter((m) => m.id !== member.id)]);
      setInviteEmail("");
      setShareMessage(`Access granted as ${member.role}.`);
    } else {
      const data = await res.json().catch(() => ({}));
      setShareMessage(data.error || "Failed to add collaborator");
    }
  };

  const copyShareLink = async () => {
    await navigator.clipboard?.writeText(window.location.href);
    setShareMessage(
      "Link copied. Access still follows the role you grant here.",
    );
  };

  const triggerExport = (type) => {
    setExportAction({ type, id: Date.now() });
  };

  const restoreVersion = async (version) => {
    if (!canEdit || restoringVersion) return;
    if (
      !confirm(
        `Restore document to version ${version.version_number}? Unsaved changes will be saved as a backup version first.`,
      )
    )
      return;

    setRestoringVersion(version.id);
    const res = await apiFetch(
      `${API}/${docId}/snapshots/${version.id}/restore`,
      {
        method: "POST",
      },
    );
    if (res.ok) {
      window.location.reload();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setRestoringVersion(null);
    alert(data.error || "Failed to restore version");
  };

  const handleTitleKey = (e) => {
    if (e.key === "Enter") saveTitle();
    if (e.key === "Escape") {
      setEditingTitle(false);
      setTitleDraft(docMeta?.title || "");
    }
  };

  const saveDisplayName = (event) => {
    event.preventDefault();
    if (nameDraft.trim()) setUserName(nameDraft.trim());
    setUserMenuOpen(false);
  };

  if (metaError) {
    return (
      <div className="doc-error">
        <p>{metaError}</p>
        <Link to="/">Back to documents</Link>
      </div>
    );
  }

  return (
    <div className="doc-page">
      <nav className="doc-nav">
        <Link to="/" className="doc-nav__back">
          Back
        </Link>

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
              onClick={() => canEdit && setEditingTitle(true)}
              title={canEdit ? "Click to rename" : "Read-only"}
            >
              {docMeta?.title || "Loading..."}
              <span
                className={`role-pill role-pill--${docMeta?.role || "viewer"}`}
              >
                {docMeta?.role || "viewer"}
              </span>
            </h1>
          )}
        </div>

        <div className="doc-nav__actions">
          <button
            className="toolbar-btn"
            onClick={() => triggerExport("pdf")}
            type="button"
          >
            PDF
          </button>
          <button
            className="toolbar-btn"
            onClick={() => triggerExport("markdown")}
            type="button"
          >
            Markdown
          </button>
          <div className="share-wrap">
            <button
              className="btn btn--primary"
              onClick={() => setShareOpen((open) => !open)}
              type="button"
            >
              Share
            </button>
            {shareOpen && (
              <div className="share-popover">
                <div className="share-link-row">
                  <input value={window.location.href} readOnly />
                  <button
                    className="toolbar-btn"
                    onClick={copyShareLink}
                    type="button"
                  >
                    Copy
                  </button>
                </div>
                {canOwn ? (
                  <form className="invite-form" onSubmit={inviteMember}>
                    <input
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="email@example.com"
                      type="email"
                      required
                    />
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </select>
                    <button className="btn btn--primary" type="submit">
                      Grant access
                    </button>
                  </form>
                ) : (
                  <p className="muted">Only owners can change access.</p>
                )}
                {shareMessage && (
                  <p className="share-message">{shareMessage}</p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="doc-nav__user">
          <button
            className="user-chip"
            style={{ backgroundColor: localUser.color }}
            title="Account"
            onClick={() => setUserMenuOpen((open) => !open)}
            type="button"
          >
            {localUser.name[0].toUpperCase()}
            <span className="user-chip__name">{localUser.name}</span>
          </button>
          {userMenuOpen && (
            <form className="user-menu" onSubmit={saveDisplayName}>
              <label>
                Display name
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                />
              </label>
              <div className="user-menu__actions">
                <button type="button" onClick={() => setUserMenuOpen(false)}>
                  Cancel
                </button>
                <button type="submit">Save</button>
              </div>
            </form>
          )}
        </div>
      </nav>

      <div className="doc-workspace">
        <div className="doc-editor-wrap">
          {ydoc && provider ? (
            <CollabEditor
              docId={docId}
              ydoc={ydoc}
              provider={provider}
              localUser={localUser}
              awarenessUsers={awarenessUsers}
              status={status}
              role={docMeta?.role}
              onAddComment={addComment}
              exportAction={exportAction}
            />
          ) : (
            <div className="doc-loading">
              <div className="spinner" />
              <p>Connecting to document...</p>
            </div>
          )}
        </div>

        <aside className="doc-sidepanel">
          <section>
            <h2>Collaborators</h2>
            <div className="side-list">
              {members.map((member) => (
                <div className="side-row" key={member.id}>
                  <span>{member.display_name}</span>
                  <span className={`role-pill role-pill--${member.role}`}>
                    {member.role}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2>Comments</h2>
            <div className="side-list">
              {comments.map((comment) => (
                <div
                  className={`comment-card ${comment.resolved ? "resolved" : ""}`}
                  key={comment.id}
                >
                  <p className="comment-quote">{comment.selected_text}</p>
                  <p>{comment.body}</p>
                  <div className="comment-meta">
                    <span>{comment.author_name}</span>
                    {canEdit && (
                      <button
                        onClick={() =>
                          resolveComment(comment.id, !comment.resolved)
                        }
                        type="button"
                      >
                        {comment.resolved ? "Reopen" : "Resolve"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {comments.length === 0 && (
                <p className="muted">No comments yet.</p>
              )}
            </div>
          </section>

          <section>
            <h2>Versions</h2>
            <div className="side-list">
              {versions.map((version) => (
                <div className="side-row version-row" key={version.id}>
                  <div>
                    <span>v{version.version_number}</span>
                    <small>
                      {version.label ||
                        new Date(version.created_at).toLocaleString()}
                    </small>
                  </div>
                  {canEdit && (
                    <button
                      className="restore-btn"
                      onClick={() => restoreVersion(version)}
                      disabled={restoringVersion === version.id}
                      type="button"
                    >
                      {restoringVersion === version.id
                        ? "Restoring"
                        : "Restore"}
                    </button>
                  )}
                </div>
              ))}
              {versions.length === 0 && (
                <p className="muted">Autosaved versions will appear here.</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
