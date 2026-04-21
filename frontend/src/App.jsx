import { Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Document from './pages/Document';

export default function App() {
  return (
    <Routes>
      <Route path="/"           element={<Home />} />
      <Route path="/doc/:docId" element={<Document />} />
      <Route path="*"           element={<Navigate to="/" replace />} />
    </Routes>
  );
}
