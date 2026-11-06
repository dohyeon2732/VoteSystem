import { useMemo, useState } from 'react';
import { api, fmtHM, fmtNum, kstToday, shortDate, type RosterStation, type TallyWindow } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import Sheet from '../components/Sheet';
import { downloadText, toCsv } from '../data/sheet';

const STATUS: Record<TallyWindow['status'], { label: string; cls: string }> = {
  reconciling: { label: '대조 중', cls: 'warn' }, matched: { label: '일치', cls: 'good' }, adjusted: { label: '조정', cls: 'danger' },
};

/** S-13 대조 현황 */
export default function Reconcile() {
  const { config, me } = useStore();
  const { data, reload } = usePolling(() => api<{ windows: TallyWindow[]; stations: RosterStation[] }>('/roster/windows'), 15000, []);
  const [day, setDay] = useState('');
  const [adj, setAdj] = useState<TallyWindow | null>(null);
  const [form, setForm] = useState({ accepted: '', tags: '', reason: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const isAdmin = me?.role === 'admin';

  const wins = data?.windows ?? [];
  const dates = useMemo(() => [...new Set([...wins.map((w) => w.date), kstToday()])].sort(), [wins]);
  const shown = day || (dates.includes(kstToday()) ? kstToday() : dates.at(-1) ?? '');
  if (!config) return <main><p className="muted center">불러오는 중…</p></main>;
  const sname = (id: string) => config.stations.find((s) => s.id === id)?.name ?? '?';
  const dayWins = wins.filter((w) => w.date === shown);
  const stationIds = isAdmin ? config.stations.map((s) => s.id) : [...new Set(wins.map((w) => w.station_id))];

  const adjust = async () => {
    if (!adj) return;
    setMsg(null);
    try {
      await api(`/roster/close/${adj.id}/adjust`, { body: { accepted_count: Number(form.accepted), tag_count: form.tags === '' ? null : Number(form.tags), reason: form.reason } });
      setAdj(null); reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  const exportCsv = () => downloadText(`대조표_${shown}.csv`, toCsv([
    ['날짜', '투표소', '구간 시작', '마감 경계', '상태', '체크 인원', '그중 준회원', '꼬리표', '인정 인원', '조정', '조정 사유', '마감자', '대조 처리자'],
    ...wins.map((w) => [w.date, sname(w.station_id), fmtHM(w.opened_at), fmtHM(w.boundary_at), STATUS[w.status].label, w.check_count, w.leave_count, w.tag_count ?? '', w.accepted_count ?? '', w.adjustment || '', w.adjust_reason ?? '', w.closed_by_name, w.matched_by_name ?? '']),
  ]));

  return (
    <main className="stack">
      <div className="card stack">
        <div className="row between">
          <h1>꼬리표 대조 현황</h1>
          {isAdmin && <button className="btn sm" onClick={exportCsv}>대조표 CSV</button>}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>투표소</th><th className="num">실시간 체크</th><th className="num">대조 완료</th><th>마지막 대조</th><th>상태</th></tr></thead>
            <tbody>
              {(data?.stations ?? []).filter((s) => stationIds.includes(s.station_id)).map((s) => (
                <tr key={s.station_id}>
                  <td style={{ fontWeight: 600 }}>{sname(s.station_id)}</td>
                  <td className="num">{fmtNum(s.live)}</td>
                  <td className="num">{fmtNum(s.reconciled)}</td>
                  <td>{s.last_boundary_at ? fmtHM(s.last_boundary_at) : '-'}</td>
                  <td>{s.reconciling && <span className="pill warn">대조 중</span>} {s.warning && <span className="pill danger">{s.warning}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <div className="chips">
          {dates.map((d) => <button key={d} className={`chip ${d === shown ? 'active' : ''}`} onClick={() => setDay(d)}>{shortDate(d)}</button>)}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>투표소</th><th>구간</th><th className="num">체크</th><th className="num">꼬리표</th><th className="num">인정</th><th>상태</th><th>처리</th><th></th></tr></thead>
            <tbody>
              {dayWins.map((w) => (
                <tr key={w.id}>
                  <td style={{ fontWeight: 600 }}>{sname(w.station_id)}</td>
                  <td>{fmtHM(w.opened_at)}~{fmtHM(w.boundary_at)}</td>
                  <td className="num">{fmtNum(w.check_count)}{w.leave_count ? <span className="muted small"> (준 {w.leave_count})</span> : null}</td>
                  <td className="num">{w.tag_count ?? '-'}</td>
                  <td className="num">{w.accepted_count ?? '-'}{w.adjustment ? <span className="small" style={{ color: 'var(--danger)' }}> ({w.adjustment > 0 ? '+' : ''}{w.adjustment})</span> : null}</td>
                  <td><span className={`pill ${STATUS[w.status].cls}`}>{STATUS[w.status].label}</span>{w.adjust_reason && <div className="small muted">{w.adjust_reason}</div>}</td>
                  <td className="small muted">{w.closed_by_name}{w.matched_by_name ? ` → ${w.matched_by_name}` : ''}</td>
                  <td>{isAdmin && w.status === 'reconciling' && <button className="btn sm" onClick={() => { setAdj(w); setForm({ accepted: String(w.check_count), tags: w.tag_count === null ? '' : String(w.tag_count), reason: '' }); setMsg(null); }}>조정</button>}</td>
                </tr>
              ))}
              {dayWins.length === 0 && <tr><td colSpan={8} className="muted center">이 날짜의 마감 기록이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Sheet open={!!adj} onClose={() => setAdj(null)} title="대조 조정 (총관리자)">
        {adj && (
          <div className="stack">
            <p className="muted small">꼬리표 분실 등으로 끝내 맞출 수 없을 때만 씁니다. 인정 인원이 공식 인원이 되고, 체크 인원과의 차이가 조정값으로 대조표에 남습니다. 휴학생 수는 체크 기준을 유지합니다.</p>
            <div className="row between"><span className="muted">{sname(adj.station_id)} · {fmtHM(adj.opened_at)}~{fmtHM(adj.boundary_at)}</span><span>체크 {fmtNum(adj.check_count)}명</span></div>
            <div className="form-row">
              <div className="field"><label>꼬리표 수</label><input className="input" inputMode="numeric" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value.replace(/[^0-9]/g, '') })} /></div>
              <div className="field"><label>인정 인원</label><input className="input" inputMode="numeric" value={form.accepted} onChange={(e) => setForm({ ...form, accepted: e.target.value.replace(/[^0-9]/g, '') })} /></div>
            </div>
            <div className="field"><label>사유</label><input className="input" placeholder="예: 꼬리표 1장 분실 확인" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
            {msg && <div className="alert danger">{msg}</div>}
            <button className="btn primary block" disabled={form.accepted === '' || !form.reason.trim()} onClick={adjust}>조정 완료 (조정값 {Number(form.accepted || 0) - adj.check_count})</button>
          </div>
        )}
      </Sheet>
    </main>
  );
}
