import React from 'react';

/**
 * Shows colored avatar bubbles for each connected collaborator
 * and a connection status pill (Live / Connecting / Offline).
 *
 * Props:
 *   localUser      — { id, name, color }  the current user
 *   awarenessUsers — [{ id, clientId, name, color }]  other connected users
 *   status         — 'connected' | 'connecting' | 'disconnected'
 */
export default function UserPresence({ localUser, awarenessUsers, status }) {
  const allUsers = [
    { ...localUser, presenceKey: `local-${localUser.id}`, isLocal: true },
    ...awarenessUsers.map((u) => ({ ...u, isLocal: false })),
  ];

  return (
    <div className="presence-bar">
      <div className="presence-avatars">
        {allUsers.map((user) => (
          <div
            key={user.presenceKey || user.id || user.clientId}
            className={`avatar ${user.isLocal ? 'avatar--local' : ''}`}
            style={{
              backgroundColor: user.color || '#888',
              borderColor:     user.color || '#888',
            }}
            title={user.isLocal ? `${user.name} (you)` : user.name}
          >
            {(user.name || '?')[0].toUpperCase()}
          </div>
        ))}
      </div>

      <div className={`status-pill status-pill--${status}`}>
        <span className="status-dot" />
        {status === 'connected'    && 'Live'}
        {status === 'connecting'   && 'Connecting…'}
        {status === 'disconnected' && 'Offline'}
      </div>
    </div>
  );
}
