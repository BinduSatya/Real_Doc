import React from 'react';

export default function UserPresence({ localUser, awarenessUsers, status }) {
  const allUsers = [
    { ...localUser, presenceKey: `local-${localUser.id}`, isLocal: true },
    ...awarenessUsers.map((u) => ({ ...u, isLocal: false })),
  ];

  return (
    <div className="presence-bar" aria-label="Connected collaborators">
      <div className="presence-users">
        {allUsers.slice(0, 4).map((user) => (
          <div
            key={user.presenceKey || user.id || user.clientId}
            className={`presence-user ${user.isLocal ? 'presence-user--local' : ''}`}
            title={user.isLocal ? `${user.name} (you)` : user.name}
          >
            <span
              className="avatar"
              style={{
                backgroundColor: user.color || '#888',
                borderColor: user.isLocal ? 'var(--accent)' : 'white',
              }}
            >
              {(user.name || '?')[0].toUpperCase()}
            </span>
            <span className="presence-name">{user.isLocal ? 'You' : user.name}</span>
          </div>
        ))}
        {allUsers.length > 4 && <span className="presence-more">+{allUsers.length - 4}</span>}
      </div>

      <div className={`status-pill status-pill--${status}`}>
        <span className="status-dot" />
        {status === 'connected' && 'Live'}
        {status === 'connecting' && 'Connecting...'}
        {status === 'disconnected' && 'Offline'}
      </div>
    </div>
  );
}
