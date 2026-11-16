import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, fmtHM, roleLabel } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';

export default function Layout() {
  const { me, setMe, config, theme, setTheme } = useStore();
  const nav = useNavigate();
  const isStation = me?.role === 'station';
  // 승인 대기 배지는 총관리자만 (투표소 계정은 /tally를 쓸 수 없음)
  const { data } = usePolling(
    () => (me?.role === 'admin' ? api<{ pending_requests: number }>('/tally') : Promise.resolve({ pending_requests: 0 })), 30000, [me?.id, me?.role],
  );
  const pending = data?.pending_requests ?? 0;
  const logout = async () => { await api('/logout', { method: 'POST', body: {} }); setMe(null); nav('/login'); };
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><img src="/logo.svg" alt="" className="brand-logo" />{config?.election.name ?? '투표율 집계'}</div>
          <nav className="nav">
            {isStation ? (
              <>
                <NavLink to="/check" className={cls}>명부 확인</NavLink>
                <NavLink to="/reconcile" className={cls}>대조 기록</NavLink>
              </>
            ) : <>
            <NavLink to="/dashboard" className={cls}>현황판</NavLink>
            <NavLink to="/check" className={cls}>명부 확인</NavLink>
            <NavLink to="/reconcile" className={cls}>대조</NavLink>
            {(!config?.roster_active || me?.role === 'admin') && <NavLink to="/input" className={cls}>{config?.roster_active ? '비상 입력' : '입력'}</NavLink>}
            {me?.role === 'admin' ? (
              <>
                <NavLink to="/admin/confirm" className={cls}>확정·승인{pending > 0 && <span className="badge">{pending}</span>}</NavLink>
                <NavLink to="/notice" className={cls}>공지</NavLink>
                <NavLink to="/admin/roster" className={cls}>선거인명부</NavLink>
                <NavLink to="/admin/stations" className={cls}>투표소 계정</NavLink>
                <NavLink to="/admin/settings" className={cls}>설정</NavLink>
                <NavLink to="/admin/members" className={cls}>위원</NavLink>
                <NavLink to="/log" className={cls}>로그</NavLink>
                <NavLink to="/admin/access-log" className={cls}>접근 로그</NavLink>
              </>
            ) : (
              <NavLink to="/requests" className={cls}>내 수정요청</NavLink>
            )}
            </>}
          </nav>
          <div className="topbar-right">
            <button className="btn sm ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="테마 전환">
              {theme === 'dark' ? '☀︎' : '☾'}
            </button>
            <span className="small muted who">
              {isStation
                ? <>{me?.name} 투표소{me?.device?.operator_name ? ` · 담당자: ${me.device.operator_name} · ${fmtHM(me.device.operator_since ?? null)}부터` : ''}</>
                : <>{me?.name} · {roleLabel(me?.role)}</>}
            </span>
            <button className="btn sm" onClick={logout}>로그아웃</button>
          </div>
        </div>
      </header>
      <Outlet />
    </>
  );
}
