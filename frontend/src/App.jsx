import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import Home from './pages/Home';
import Document from './pages/Document';
import Login from './pages/Login';

function ProtectedRoute({ children }) {
  const { user, booting } = useAuth();
  if (booting) return <div className="doc-loading"><div className="spinner" /><p>Starting session...</p></div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login"      element={<Login />} />
      <Route path="/"           element={<ProtectedRoute><Home /></ProtectedRoute>} />
      <Route path="/doc/:docId" element={<ProtectedRoute><Document /></ProtectedRoute>} />
      <Route path="*"           element={<Navigate to="/" replace />} />
    </Routes>
  );
}
