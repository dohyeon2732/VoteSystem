import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useStore } from '../app/store';
import Layout from '../components/Layout';
import Login from '../pages/Login';
import Input from '../pages/Input';
import Dashboard from '../pages/Dashboard';
import Notice from '../pages/Notice';
import AdminConfirm from '../pages/AdminConfirm';
import AdminSettings from '../pages/AdminSettings';
import AdminMembers from '../pages/AdminMembers';
import Log from '../pages/Log';
import Requests from '../pages/Requests';

function Guard({ admin, children }: { admin?: boolean; children: JSX.Element }) {
  const { me } = useStore();
  const loc = useLocation();
  if (me === undefined) return <main className="narrow"><p className="muted center">불러오는 중…</p></main>;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (admin && me.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return children;
}

export default function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/input" element={<Input />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/notice" element={<Guard admin><Notice /></Guard>} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/log" element={<Guard admin><Log /></Guard>} />
        <Route path="/admin/confirm" element={<Guard admin><AdminConfirm /></Guard>} />
        <Route path="/admin/settings" element={<Guard admin><AdminSettings /></Guard>} />
        <Route path="/admin/members" element={<Guard admin><AdminMembers /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
