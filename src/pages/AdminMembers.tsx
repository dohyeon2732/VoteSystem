import { useState, type FormEvent } from 'react';
import { api, fmtTime, type MemberRow } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import Sheet from '../components/Sheet';

export default function AdminMembers() {
  const { me } = useStore();
  const { data, reload } = usePolling(() => api<{ members: MemberRow[] }>('/members'), 15000, []);
  const [name, setName] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [issued, setIssued] = useState<{ name: string; code: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg(null);
    try { await fn(); await reload(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const add = (e: FormEvent) => { e.preventDefault(); run(async () => { const r = await api<{ code: string }>('/members', { body: { name, role } }); setIssued({ name, code: r.code }); setName(''); }); };
  const regen = (m: MemberRow) => { if (!window.confirm(`${m.name}의 코드를 재발급할까요? 이전 코드는 즉시 쓸 수 없게 됩니다.`)) return; run(async () => { const r = await api<{ code: string }>(`/members/${m.id}/regenerate`, { body: {} }); setIssued({ name: m.name, code: r.code }); }); };
  const setActive = (m: MemberRow, active: boolean) => run(() => api(`/members/${m.id}`, { method: 'PUT', body: { active } }));
  const setRoleOf = (m: MemberRow, r: 'admin' | 'member') => run(() => api(`/members/${m.id}`, { method: 'PUT', body: { role: r } }));

  const members = data?.members ?? [];
  const active = members.filter((m) => m.active);
  const inactive = members.filter((m) => !m.active);
  const renderRow = (m: MemberRow) => (
    <tr key={m.id} style={{ opacity: m.active ? 1 : 0.6 }}>
      <td style={{ fontWeight: 600 }}>{m.name}{m.id === me?.id && <span className="muted small"> (나)</span>}</td>
      <td>
        <select className="input" style={{ width: 120 }} value={m.role} disabled={busy || !m.active} onChange={(e) => setRoleOf(m, e.target.value as 'admin' | 'member')}>
          <option value="member">선관위원</option><option value="admin">총관리자</option>
        </select>
      </td>
      <td className="small muted">{m.last_login_at ? fmtTime(m.last_login_at) : '-'}</td>
      <td>{m.active ? <span className="pill good">활성</span> : <span className="pill muted">비활성</span>}</td>
      <td><span className="actions">
        {m.active ? (
          <>
            <button className="btn sm" disabled={busy} onClick={() => regen(m)}>코드 재발급</button>
            <button className="btn sm ghost" disabled={busy || m.id === me?.id} onClick={() => setActive(m, false)}>비활성</button>
          </>
        ) : (
          <button className="btn sm" disabled={busy} onClick={() => setActive(m, true)}>복구</button>
        )}
      </span></td>
    </tr>
  );
  const head = <thead><tr><th>이름</th><th>권한</th><th>최근 로그인</th><th>상태</th><th></th></tr></thead>;
  return (
    <main className="stack" style={{ maxWidth: 860 }}>
      {msg && <div className="alert danger">{msg}</div>}
      <form className="card stack" onSubmit={add}>
        <h1>위원 등록</h1>
        <p className="muted small">등록하면 8자리 코드가 한 번만 표시됩니다. 위원에게 직접 전달하세요.</p>
        <div className="form-row">
          <div className="field wide"><label htmlFor="mname">이름</label><input id="mname" className="input" placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div className="field" style={{ flexBasis: 140 }}><label htmlFor="mrole">권한</label>
            <select id="mrole" className="input" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
              <option value="member">선관위원</option><option value="admin">총관리자</option>
            </select></div>
          <button className="btn primary" disabled={busy || !name.trim()}>등록</button>
        </div>
      </form>

      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h1>관리자 명부</h1>
          <span className="pill accent">활성 {active.length}명</span>
        </div>
        <div className="table-wrap">
          <table>
            {head}
            <tbody>
              {active.map(renderRow)}
              {active.length === 0 && <tr><td colSpan={5} className="muted center">활성 위원이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <button className="row between" style={{ width: '100%', background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => setShowInactive((v) => !v)} aria-expanded={showInactive}>
          <h2>비활성 위원 <span className="muted" style={{ fontWeight: 500 }}>{inactive.length}명</span></h2>
          <span className="muted small">{showInactive ? '접기 ▴' : '펼치기 ▾'}</span>
        </button>
        {showInactive && (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              {head}
              <tbody>
                {inactive.map(renderRow)}
                {inactive.length === 0 && <tr><td colSpan={5} className="muted center">비활성 위원이 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Sheet open={!!issued} onClose={() => setIssued(null)} title={issued ? `${issued.name} 접근 코드` : undefined}>
        {issued && (
          <div className="stack">
            <div className="code-box">{issued.code}</div>
            <p className="muted small center">이 코드는 다시 볼 수 없습니다. 지금 전달하세요. 로그인은 이름 + 코드입니다.</p>
            <button className="btn primary block" onClick={() => { navigator.clipboard?.writeText(`${issued.name} / ${issued.code}`); setIssued(null); }}>복사하고 닫기</button>
          </div>
        )}
      </Sheet>
    </main>
  );
}
