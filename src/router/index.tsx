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
import RosterCheck from '../pages/RosterCheck';
import AdminRoster from '../pages/AdminRoster';
import AdminShifts from '../pages/AdminShifts';
import Reconcile from '../pages/Reconcile';
import AccessLog from '../pages/AccessLog';

function Guard({ admin, children }: { admin?: boolean; children: JSX.Element }) {
  const { me } = useStore();
  const loc = useLocation();
  if (me === undefined) return <main className="narrow"><p className="muted center">불러오는 중…</p></main>;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (admin && me.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return children;
}

/** 명부 운영 중에는 손 입력이 총관리자 비상용 (FR-20 v1.1) */
function InputGate() {
  const { me, config } = useStore();
  if (config?.roster_active && me?.role !== 'admin') return <Navigate to="/check" replace />;
  return <Input />;
}

export default function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/input" element={<InputGate />} />
        <Route path="/check" element={<RosterCheck />} />
        <Route path="/reconcile" element={<Reconcile />} />
        <Route path="/admin/roster" element={<Guard admin><AdminRoster /></Guard>} />
        <Route path="/admin/shifts" element={<Guard admin><AdminShifts /></Guard>} />
        <Route path="/admin/access-log" element={<Guard admin><AccessLog /></Guard>} />
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
