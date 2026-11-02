import { useEffect, useMemo, useState } from 'react';
import { api, fmtNum, fmtTime, pointLabel, type ChangeRequest, type Entry } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import PointPicker, { type Point } from '../components/PointPicker';
import { allPoints } from '../data/points';
import { useLivePoint } from '../hooks/useLivePoint';

export default function AdminConfirm() {
  const { config } = useStore();
  const fallback = useMemo<Point | null>(() => { const p = config ? allPoints(config)[0] : undefined; return p ? { date: p.date, time: p.time } : null; }, [config]);
  const { point, setPoint, following, resetToLive, isLive } = useLivePoint(config, fallback);
  const { data: ent, reload: reloadEntries } = usePolling(() => api<{ entries: Entry[] }>('/entries'), 10000, []);
  const { data: reqs, reload: reloadReqs } = usePolling(() => api<{ requests: ChangeRequest[] }>('/change-requests'), 10000, []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<{ entryId: string; cum: string; leave: string } | null>(null);


  const rows = useMemo(() => {
    if (!config || !point) return [];
    const day = config.days.find((d) => d.date === point.date);
    return [...config.stations].sort((a, b) => a.sort - b.sort).map((station) => {
      const slot = day ? config.slots.find((s) => s.station_id === station.id && s.day_id === day.id && s.time === point.time) : undefined;
      const entry = slot ? ent?.entries.find((e) => e.slot_id === slot.id) ?? null : null;
      return { station, slot, entry };
    }).filter((r) => r.slot);
  }, [config, point, ent]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(ok); await reloadEntries(); await reloadReqs(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const bulk = (confirmed: boolean) => run(() => api('/slots/confirm', { body: { date: point!.date, time: point!.time, confirmed } }), confirmed ? '이 시점의 입력값을 모두 확정했습니다.' : '이 시점의 확정을 해제했습니다.');
  const one = (e: Entry, confirmed: boolean) => run(() => api(`/entries/${e.id}/confirm`, { body: { confirmed } }), confirmed ? '확정했습니다.' : '확정을 해제했습니다.');
  const decide = (r: ChangeRequest, approve: boolean) => run(() => api(`/change-requests/${r.id}/decide`, { body: { approve, note: notes[r.id] ?? '' } }), approve ? '승인하여 반영했습니다.' : '거절했습니다.');
  const saveEdit = (r: { station: { id: string }; slot?: { id: string } }) => run(async () => {
    if (!edit) return;
    await api('/entries', { body: { station_id: r.station.id, slot_id: r.slot!.id, cumulative: Number(edit.cum), leave_cumulative: Number(edit.leave), overwrite: true } });
    setEdit(null);
  }, '관리자 직접 수정으로 저장했습니다.');

  if (!config || !point) return <main><p className="muted center">불러오는 중…</p></main>;
  const pending = (reqs?.requests ?? []).filter((r) => r.status === 'pending');
  const decided = (reqs?.requests ?? []).filter((r) => r.status !== 'pending').slice(0, 20);
  const entered = rows.filter((r) => r.entry).length;
  const confirmedN = rows.filter((r) => r.entry?.confirmed).length;
  const where = (r: ChangeRequest) => {
    const slot = config.slots.find((s) => s.id === r.entry?.slot_id);
    const st = config.stations.find((s) => s.id === r.entry?.station_id);
    const day = config.days.find((d) => d.id === slot?.day_id);
    return `${st?.name ?? ''} · ${day ? pointLabel({ date: day.date, time: slot!.time }) : ''}`;
  };

  return (
    <main className="stack">
      {msg && <div className="alert info">{msg}</div>}

      <div className="card stack">
        <div className="row between">
          <h1>수정요청 승인</h1>
          <span className={`pill ${pending.length ? 'danger' : 'muted'}`}>대기 {pending.length}건</span>
        </div>
        {pending.length === 0 ? <p className="muted">대기 중인 수정요청이 없습니다.</p> : pending.map((r) => (
          <div className="card stack" key={r.id} style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
            <div className="row between">
              <div>
                <div style={{ fontWeight: 700 }}>{where(r)}</div>
                <div className="small muted">{r.requested_by_name} · {fmtTime(r.requested_at)}</div>
              </div>
              <div className="mono" style={{ fontWeight: 700 }}>
                {fmtNum(r.entry?.cumulative ?? 0)}명 → {fmtNum(r.new_cumulative)}명
                <div className="small muted" style={{ fontWeight: 400 }}>휴학생 {r.entry?.leave_cumulative ?? 0} → {r.new_leave_cumulative}</div>
              </div>
            </div>
            <div>사유: {r.reason}</div>
            <input className="input" placeholder="회신 메모 (선택)" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => decide(r, true)}>승인 · 반영</button>
              <button className="btn danger" disabled={busy} onClick={() => decide(r, false)}>거절</button>
            </div>
          </div>
        ))}
      </div>

      <div className="card stack">
        <div className="row between">
          <h1>시점 확정</h1>
          <span className="pill accent">입력 {entered} / {rows.length} · 확정 {confirmedN}</span>
        </div>
        <PointPicker config={config} value={point} onChange={setPoint} following={following} isLive={isLive} onResetToLive={resetToLive} />
        <div className="row">
          <button className="btn primary" disabled={busy || entered === 0} onClick={() => bulk(true)}>{pointLabel(point)} 일괄 확정</button>
          <button className="btn" disabled={busy || confirmedN === 0} onClick={() => bulk(false)}>일괄 해제</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>투표소</th><th className="num">누적</th><th className="num">휴학생</th><th>입력자</th><th>상태</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.station.id}>
                  <td style={{ fontWeight: 600 }}>{r.station.name}</td>
                  {edit && r.entry && edit.entryId === r.entry.id ? (
                    <>
                      <td className="num"><input className="input" style={{ width: 110 }} inputMode="numeric" value={edit.cum} onChange={(e) => setEdit((cur) => cur && { ...cur, cum: e.target.value.replace(/[^0-9]/g, '') })} /></td>
                      <td className="num"><input className="input" style={{ width: 90 }} inputMode="numeric" value={edit.leave} onChange={(e) => setEdit((cur) => cur && { ...cur, leave: e.target.value.replace(/[^0-9]/g, '') })} /></td>
                    </>
                  ) : (
                    <>
                      <td className="num">{r.entry ? fmtNum(r.entry.cumulative) : <span className="pill danger">미입력</span>}</td>
                      <td className="num">{r.entry ? fmtNum(r.entry.leave_cumulative) : ''}</td>
                    </>
                  )}
                  <td className="small muted">{r.entry ? `${r.entry.entered_by_name} · ${fmtTime(r.entry.entered_at)}` : ''}</td>
                  <td>{r.entry ? (r.entry.confirmed ? <span className="pill good">확정</span> : <span className="pill muted">확정 전</span>) : ''}</td>
                  <td>
                    {r.entry && (edit?.entryId === r.entry.id ? (
                      <span className="actions">
                        <button className="btn sm primary" disabled={busy} onClick={() => saveEdit(r)}>저장</button>
                        <button className="btn sm" onClick={() => setEdit(null)}>취소</button>
                      </span>
                    ) : (
                      <span className="actions">
                        <button className="btn sm" disabled={busy} onClick={() => one(r.entry!, !r.entry!.confirmed)}>{r.entry.confirmed ? '해제' : '확정'}</button>
                        <button className="btn sm ghost" disabled={busy} onClick={() => setEdit({ entryId: r.entry!.id, cum: String(r.entry!.cumulative), leave: String(r.entry!.leave_cumulative) })}>수정</button>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {decided.length > 0 && (
        <div className="card">
          <h2 style={{ marginBottom: 8 }}>최근 처리된 요청</h2>
          <div className="list">
            {decided.map((r) => (
              <div className="list-item" key={r.id} style={{ cursor: 'default' }}>
                <div><div className="title">{where(r)}</div><div className="sub">{r.requested_by_name} · {fmtNum(r.new_cumulative)}명 · {r.reason}</div></div>
                <div className="right">{r.status === 'approved' ? <span className="pill good">승인</span> : <span className="pill danger">거절</span>}<div className="small muted">{r.decided_by_name} · {fmtTime(r.decided_at)}</div></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
