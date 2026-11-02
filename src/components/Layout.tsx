import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';

export default function Layout() {
  const { me, setMe, config, theme, setTheme } = useStore();
  const nav = useNavigate();
  const { data } = usePolling(() => api<{ pending_requests: number }>('/tally'), 30000, [me?.id]);
  const pending = data?.pending_requests ?? 0;
  const logout = async () => { await api('/logout', { method: 'POST', body: {} }); setMe(null); nav('/login'); };
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><img src="/logo.svg" alt="" className="brand-logo" />{config?.election.name ?? '투표율 집계'}</div>
          <nav className="nav">
            <NavLink to="/dashboard" className={cls}>현황판</NavLink>
            <NavLink to="/input" className={cls}>입력</NavLink>
            {me?.role === 'admin' ? (
              <>
                <NavLink to="/admin/confirm" className={cls}>확정·승인{pending > 0 && <span className="badge">{pending}</span>}</NavLink>
                <NavLink to="/notice" className={cls}>공지</NavLink>
                <NavLink to="/admin/settings" className={cls}>설정</NavLink>
                <NavLink to="/admin/members" className={cls}>명부</NavLink>
                <NavLink to="/log" className={cls}>로그</NavLink>
              </>
            ) : (
              <NavLink to="/requests" className={cls}>내 수정요청</NavLink>
            )}
          </nav>
          <div className="topbar-right">
            <button className="btn sm ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="테마 전환">
              {theme === 'dark' ? '☀︎' : '☾'}
            </button>
            <span className="small muted who">{me?.name} · {me?.role === 'admin' ? '총관리자' : '선관위원'}</span>
            <button className="btn sm" onClick={logout}>로그아웃</button>
          </div>
        </div>
      </header>
      <Outlet />
    </>
  );
}
