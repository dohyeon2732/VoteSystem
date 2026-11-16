import { useState } from 'react';
import { api, fmtHM, fmtTime, type DeviceRow, type MemberRow, type StationAccounts } from '../apis';
import { usePolling } from '../hooks/usePolling';
import Sheet from '../components/Sheet';

type Issued = { title: string; rows: { name: string; code: string }[] };

/** 기기 종류를 짧게 (목록에서 모르는 기기를 알아보기 위한 정도) */
function deviceKind(ua: string | null): string {
  if (!ua) return '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '';
  const br = /SamsungBrowser/.test(ua) ? '삼성 인터넷' : /KAKAOTALK/.test(ua) ? '카카오톡' : /NAVER/.test(ua) ? '네이버' : /Edg\//.test(ua) ? 'Edge'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  return [os, br].filter(Boolean).join(' · ');
}

/** S-12 투표소 계정·기기 (FR-92, FR-94b) */
export default function AdminStations() {
  const { data, reload } = usePolling(() => api<StationAccounts>('/stations/accounts'), 15000, []);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [msg, setMsg] = useState<{ kind: 'danger' | 'good'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPast, setShowPast] = useState<Record<string, boolean>>({});

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg(null);
    try { await fn(); await reload(); } catch (e) { setMsg({ kind: 'danger', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const rows = data?.stations ?? [];
  const missing = rows.filter((r) => !r.accounts.some((a) => a.active)).length;
  const activeDevices = rows.reduce((a, r) => a + r.devices.filter((d) => d.status === 'active').length, 0);

  const bulk = () => run(async () => {
    const r = await api<{ created: { name: string; code: string }[] }>('/stations/accounts/bulk', { body: {} });
    if (r.created.length) setIssued({ title: `투표소 계정 ${r.created.length}개`, rows: r.created });
    else setMsg({ kind: 'good', text: '모든 투표소에 이미 계정이 있습니다.' });
  });
  const regen = (a: MemberRow) => {
    if (!window.confirm(`${a.name} 투표소 계정의 코드를 재발급할까요?\n이 계정으로 로그인한 모든 기기가 바로 로그아웃되고, 새 코드로 다시 로그인해야 합니다.`)) return;
    run(async () => {
      const r = await api<{ code: string }>(`/members/${a.id}/regenerate`, { body: {} });
      setIssued({ title: `${a.name} 새 코드`, rows: [{ name: a.name, code: r.code }] });
    });
  };
  const revoke = (d: DeviceRow, stationName: string) => {
    if (!window.confirm(`${stationName} ${d.device_no}번 기기${d.operator_name ? ` (담당자 ${d.operator_name})` : ''}를 강제 로그아웃할까요?\n그 기기는 다음 요청에서 로그인 화면으로 갑니다.`)) return;
    run(() => api(`/devices/${d.id}/revoke`, { body: {} }));
  };
  const endAll = () => {
    const c = window.prompt('선거가 끝났을 때만 쓰세요. 모든 투표소 계정을 비활성화하고 로그인한 기기를 모두 끊습니다.\n계속하려면 "투표소계정종료"를 입력하세요.');
    if (!c) return;
    run(async () => {
      const r = await api<{ accounts: number; devices: number }>('/stations/accounts/deactivate', { body: { confirm: c } });
      setMsg({ kind: 'good', text: `투표소 계정 ${r.accounts}개를 비활성화하고 기기 ${r.devices}대를 로그아웃했습니다.` });
    });
  };
  const copyAll = (i: Issued) => {
    navigator.clipboard?.writeText(i.rows.map((r) => `${r.name}\t${r.code}`).join('\n'));
  };

  return (
    <main className="stack" style={{ maxWidth: 960 }}>
      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
      <div className="card stack">
        <div className="row between">
          <h1>투표소 계정·기기</h1>
          <span className="pill accent">접속 중 기기 {activeDevices}대</span>
        </div>
        <p className="muted small">
          투표소마다 공용 계정 1개를 두고, 그 투표소 근무자들이 같은 코드로 각자 기기에서 로그인합니다. 로그인은 10시간 유지되고 자정에 끝납니다.
          누가 조작했는지는 기기마다 입력한 담당자 이름으로 남습니다. 코드는 선거 기간 내내 같은 코드를 쓰고, 유출이 의심될 때만 재발급하세요.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={busy || !data || missing === 0} onClick={bulk}>
            {missing > 0 ? `계정 없는 투표소 ${missing}곳 계정 만들기` : '모든 투표소에 계정 있음'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={endAll}>선거 종료: 투표소 계정 모두 비활성화</button>
        </div>
      </div>

      {rows.map(({ station, accounts, devices }) => {
        const acct = accounts.find((a) => a.active) ?? null;
        const live = devices.filter((d) => d.status === 'active');
        const past = devices.filter((d) => d.status !== 'active');
        const renderDevice = (d: DeviceRow) => (
          <div key={d.id} className="list-item" style={{ alignItems: 'flex-start', opacity: d.status === 'active' ? 1 : 0.6 }}>
            <div>
              <div className="title">
                {d.device_no}번 기기 · {d.operator_name ? <>담당자 {d.operator_name} <span className="muted small">({fmtHM(d.operator_since)}부터)</span></> : <span className="pill warn">담당자 미등록</span>}
                {d.status === 'revoked' && <span className="pill muted" style={{ marginLeft: 6 }}>강제 로그아웃</span>}
                {d.status === 'expired' && <span className="pill muted" style={{ marginLeft: 6 }}>만료</span>}
              </div>
              <div className="sub">
                로그인 {fmtTime(d.created_at)} · 마지막 활동 {fmtHM(d.last_seen_at)} · {fmtHM(d.expires_at)}까지{deviceKind(d.user_agent) ? ` · ${deviceKind(d.user_agent)}` : ''}
              </div>
              {d.history.length > 0 && (
                <div className="sub">교대: {d.history.map((h) => `${h.operator_name}(${fmtHM(h.started_at)})`).join(' → ')}</div>
              )}
            </div>
            <div className="right">
              {d.status === 'active' && <button className="btn sm ghost" disabled={busy} onClick={() => revoke(d, station.name)}>강제 로그아웃</button>}
            </div>
          </div>
        );
        return (
          <div key={station.id} className="card stack">
            <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
              <div>
                <h2>{station.name}</h2>
                <div className="small muted">
                  운영 {station.open_time}~{station.close_time}
                  {acct ? ` · 계정 "${acct.name}" · 최근 로그인 ${acct.last_login_at ? fmtTime(acct.last_login_at) : '없음'}` : ''}
                </div>
              </div>
              <div className="actions">
                {acct ? <span className="pill good">계정 활성</span> : <span className="pill warn">계정 없음</span>}
                {acct && <button className="btn sm" disabled={busy} onClick={() => regen(acct)}>코드 재발급</button>}
              </div>
            </div>
            {live.length > 0 ? <div className="list">{live.map(renderDevice)}</div> : <div className="muted small">접속 중인 기기가 없습니다.</div>}
            {past.length > 0 && (
              <>
                <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowPast((s) => ({ ...s, [station.id]: !s[station.id] }))}>
                  지난 기기 {past.length}대 {showPast[station.id] ? '접기 ▴' : '보기 ▾'}
                </button>
                {showPast[station.id] && <div className="list">{past.map(renderDevice)}</div>}
              </>
            )}
          </div>
        );
      })}

      <Sheet open={!!issued} onClose={() => setIssued(null)} title={issued?.title}>
        {issued && (
          <div className="stack">
            <div className="alert warn small">이 코드는 다시 볼 수 없습니다. 지금 복사해 각 투표소 근무자에게만 전달하세요. 로그인은 이름(투표소 이름) + 코드입니다.</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>이름</th><th>코드</th></tr></thead>
                <tbody>
                  {issued.rows.map((r) => (
                    <tr key={r.name}><td>{r.name}</td><td className="mono" style={{ fontSize: 17, letterSpacing: '0.12em' }}>{r.code}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn primary block" onClick={() => { copyAll(issued); setIssued(null); }}>모두 복사하고 닫기</button>
          </div>
        )}
      </Sheet>
    </main>
  );
}
