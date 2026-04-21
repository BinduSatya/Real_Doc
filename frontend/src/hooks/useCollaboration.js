/**
 * useCollaboration
 * ----------------
 * Sets up a Yjs document + WebsocketProvider for a given document ID.
 * Returns the Y.Doc, the provider, and live connection/user state.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

// Palette of colors assigned to users
const USER_COLORS = [
  '#E63946', '#2A9D8F', '#E9C46A', '#F4A261',
  '#A8DADC', '#457B9D', '#C77DFF', '#06D6A0',
];

function randomColor() {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

function randomName() {
  const adjectives = ['Swift', 'Bold', 'Calm', 'Keen', 'Wise', 'Bright'];
  const nouns      = ['Owl', 'Fox', 'Bear', 'Deer', 'Hawk', 'Wolf'];
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

// Persist user identity across refreshes
function getLocalUser() {
  try {
    const stored = localStorage.getItem('collab-user');
    if (stored) return JSON.parse(stored);
  } catch (_) {}
  const user = { name: randomName(), color: randomColor() };
  localStorage.setItem('collab-user', JSON.stringify(user));
  return user;
}

export function useCollaboration(docId) {
  const ydocRef    = useRef(null);
  const providerRef = useRef(null);

  const [status,      setStatus]      = useState('connecting'); // connecting | connected | disconnected
  const [awarenessUsers, setAwarenessUsers] = useState([]);

  // Stable local user identity
  const localUser = useRef(getLocalUser()).current;

  useEffect(() => {
    if (!docId) return;

    // Create a fresh Y.Doc for this document
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    // Connect via WebSocket (proxied through Vite dev server → Express)
    const wsUrl  = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    const provider = new WebsocketProvider(wsUrl, `ws/${docId}`, ydoc, {
      connect: true,
    });
    providerRef.current = provider;

    // Set local user awareness state
    provider.awareness.setLocalStateField('user', {
      name:  localUser.name,
      color: localUser.color,
    });

    // Track connection status
    provider.on('status', ({ status }) => setStatus(status));

    // Track who else is editing
    const updateUsers = () => {
      const states = [...provider.awareness.getStates().entries()];
      const users  = states
        .filter(([clientId]) => clientId !== provider.awareness.clientID)
        .map(([clientId, state]) => ({ clientId, ...state.user }))
        .filter((u) => u.name); // filter disconnected / empty states
      setAwarenessUsers(users);
    };
    provider.awareness.on('change', updateUsers);

    return () => {
      provider.awareness.off('change', updateUsers);
      provider.destroy();
      ydoc.destroy();
      ydocRef.current    = null;
      providerRef.current = null;
    };
  }, [docId]);

  // Allow the UI to update the local user's display name
  const setUserName = useCallback((name) => {
    localUser.name = name;
    localStorage.setItem('collab-user', JSON.stringify(localUser));
    providerRef.current?.awareness.setLocalStateField('user', {
      name,
      color: localUser.color,
    });
  }, [localUser]);

  return {
    ydoc:       ydocRef.current,
    provider:   providerRef.current,
    status,
    localUser,
    setUserName,
    awarenessUsers,
  };
}
