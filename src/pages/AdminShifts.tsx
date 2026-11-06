import { useMemo, useState } from 'react';
import { api, ApiError, shortDate, type MemberRow, type Shift } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import { readTable, toHM, toYMD } from '../data/sheet';

interface RawRow { date: string; start: string; end: string; station: string; member: string }

function guess(headers: string[], words: string[]) {
  return headers.findIndex((h) => words.some((w) => h.replace(/\s/g, '').includes(w)));
}

/** S-12 근무표 (FR-92) */
export default function AdminShifts() {
  const { config } = useStore();
  const { data, reload } = usePolling(() => api<{ shifts: Shift[] }>('/shifts'), 30000, []);
  const { data: mem } = usePolling(() => api<{ members: MemberRow[] }>('/members'), 60000, []);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [errors, setErrors] = useState<{ row: number; message: string }[]>([]);
  const [pending, setPending] = useState<RawRow[] | null>(null);
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Partial<Shift>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [day, setDay] = useState('');

  const members = (mem?.members ?? []).filter((m) => m.active);
  const shifts = data?.shifts ?? [];
  const dates = useMemo(() => [...new Set(shifts.map((s) => s.date))].sort(), [shifts]);
  const shownDate = day || dates[0] || '';

  if (!config) return <main><p className="muted center">불러오는 중…</p></main>;
  const sname = (id: string) => config.stations.find((s) => s.id === id)?.name ?? '?';
  const mname = (id: string) => (mem?.members ?? []).find((m) => m.id === id)?.name ?? '?';

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null); setErrors([]);
    try { await fn(); await reload(); setMsg({ text: ok, ok: true }); }
    catch (e) {
      if (e instanceof ApiError && e.extra?.errors) setErrors(e.extra.errors);
      setMsg({ text: (e as Error).message, ok: false });
    } finally { setBusy(false); }
  };

  const onFile = async (f?: File) => {
    if (!f) return;
    setMsg(null); setErrors([]); setPending(null);
    try {
      const t = await readTable(f);
      const h = t[0] ?? [];
      const idx = { date: guess(h, ['날짜', '일자']), start: guess(h, ['시작']), end: guess(h, ['종료', '끝']), station: guess(h, ['투표소']), member: guess(h, ['위원', '이름', '성명']) };
      const missing = Object.entries(idx).filter(([, v]) => v < 0).map(([k]) => ({ date: '날짜', start: '시작', end: '종료', station: '투표소', member: '위원 이름' }[k]));
      if (missing.length) throw new Error(`열을 찾지 못했습니다: ${missing.join(', ')}. 헤더에 날짜·시작·종료·투표소·위원 이름이 있어야 합니다.`);
      setPending(t.slice(1).map((r) => ({ date: toYMD(r[idx.date] ?? ''), start: toHM(r[idx.start] ?? ''), end: toHM(r[idx.end] ?? ''), station: (r[idx.station] ?? '').trim(), member: (r[idx.member] ?? '').trim() })));
    } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
  };

  const save = () => run(async () => {
    if (editing) await api(`/shifts/${editing}`, { method: 'PUT', body: form });
    else await api('/shifts', { body: form });
    setForm({}); setEditing(null);
  }, editing ? '근무를 수정했습니다.' : '근무를 추가했습니다.');

  const dayShifts = shifts.filter((s) => s.date === shownDate).sort((a, b) => sname(a.station_id).localeCompare(sname(b.station_id)) || a.start_time.localeCompare(b.start_time));

  return (
    <main className="stack">
      {msg && <div className={`alert toast ${msg.ok ? 'good' : 'danger'}`} role="status" onClick={() => setMsg(null)}>{msg.text}</div>}
      <div className="card stack">
        <h1>근무표 등록</h1>
        <p className="muted small">위원은 근무 시간(시작 15분 전 ~ 종료 15분 후)에 근무 투표소 선거구의 명부만 조회할 수 있습니다. 엑셀/CSV 열: 날짜, 시작, 종료, 투표소, 위원 이름. 위원 이름은 위원 명부와, 투표소 이름은 설정의 투표소 이름과 같아야 합니다.</p>
        <input type="file" accept=".xlsx,.csv" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        {pending && (
          <div className="stack">
            <div className="small">{pending.length}행을 읽었습니다.</div>
            <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> 기존 근무표 전체 교체</label>
            <button className="btn primary" disabled={busy} onClick={() => run(() => api('/shifts/bulk', { body: { rows: pending, replace } }).then(() => setPending(null)), `근무표 ${pending.length}행을 등록했습니다.`)}>등록</button>
          </div>
        )}
        {errors.length > 0 && (
          <div className="alert danger small">
            {errors.slice(0, 30).map((e, i) => <div key={i}>{e.row}행: {e.message}</div>)}
            {errors.length > 30 && <div>외 {errors.length - 30}건</div>}
          </div>
        )}
      </div>

      <div className="card stack">
        <h1>{editing ? '근무 수정' : '근무 추가'}</h1>
        <div className="form-row">
          <select className="input" value={form.member_id ?? ''} onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
            <option value="">위원</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select className="input" value={form.station_id ?? ''} onChange={(e) => setForm({ ...form, station_id: e.target.value })}>
            <option value="">투표소</option>{config.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <input className="input" type="date" value={form.date ?? ''} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <input className="input" type="time" value={form.start_time ?? ''} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
          <input className="input" type="time" value={form.end_time ?? ''} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
          <button className="btn primary" disabled={busy || !form.member_id || !form.station_id || !form.date || !form.start_time || !form.end_time} onClick={save}>{editing ? '수정' : '추가'}</button>
          {editing && <button className="btn ghost" onClick={() => { setEditing(null); setForm({}); }}>취소</button>}
        </div>
      </div>

      <div className="card stack">
        <div className="row between">
          <h1>근무표</h1>
          <span className="pill accent">{shifts.length}건</span>
        </div>
        {dates.length > 0 && (
          <div className="chips">
            {dates.map((d) => <button key={d} className={`chip ${d === shownDate ? 'active' : ''}`} onClick={() => setDay(d)}>{shortDate(d)}</button>)}
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead><tr><th>투표소</th><th>시간</th><th>위원</th><th></th></tr></thead>
            <tbody>
              {dayShifts.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{sname(s.station_id)}</td>
                  <td>{s.start_time}~{s.end_time}</td>
                  <td>{mname(s.member_id)}</td>
                  <td><span className="actions">
                    <button className="btn sm" onClick={() => { setEditing(s.id); setForm(s); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>수정</button>
                    <button className="btn sm ghost" disabled={busy} onClick={() => { if (confirm(`${mname(s.member_id)} ${s.start_time}~${s.end_time} 근무를 삭제할까요?`)) run(() => api(`/shifts/${s.id}`, { method: 'DELETE' }), '삭제했습니다.'); }}>삭제</button>
                  </span></td>
                </tr>
              ))}
              {dayShifts.length === 0 && <tr><td colSpan={4} className="muted center">등록된 근무가 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
