import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { api, ApiError, fmtNum, fmtPct, fmtTime, pointLabel, slotEpoch, type Entry, type Station } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import PointPicker, { type Point } from '../components/PointPicker';
import Sheet from '../components/Sheet';
import { allPoints } from '../data/points';
import { useLivePoint } from '../hooks/useLivePoint';

interface Row {
  station: Station; districtName: string; slotId: string | null; entry: Entry | null;
}

export default function Input() {
  const { config, me, refreshConfig } = useStore();
  const fallback = useMemo<Point | null>(() => { const p = config ? allPoints(config)[0] : undefined; return p ? { date: p.date, time: p.time } : null; }, [config]);
  const { point, setPoint, following, resetToLive, isLive } = useLivePoint(config, fallback);
  const { data, reload } = usePolling(() => api<{ entries: Entry[] }>('/entries'), 10000, []);
  const entries = data?.entries ?? [];
  const [active, setActive] = useState<Row | null>(null);

  useEffect(() => { const t = setInterval(refreshConfig, 60000); return () => clearInterval(t); }, [refreshConfig]);

  const rows = useMemo<Row[]>(() => {
    if (!config || !point) return [];
    const day = config.days.find((d) => d.date === point.date);
    return [...config.stations].sort((a, b) => a.sort - b.sort).map((station) => {
      const slot = day ? config.slots.find((s) => s.station_id === station.id && s.day_id === day.id && s.time === point.time) : undefined;
      const entry = slot ? entries.find((e) => e.slot_id === slot.id) ?? null : null;
      return { station, districtName: config.districts.find((d) => d.id === station.district_id)?.name ?? '', slotId: slot?.id ?? null, entry };
    });
  }, [config, point, entries]);

  const entered = rows.filter((r) => r.slotId && r.entry).length;
  const applicable = rows.filter((r) => r.slotId).length;

  if (!config || !point) return <main className="narrow"><p className="muted center">불러오는 중…</p></main>;
  const locked = config.election.input_locked && me?.role !== 'admin';

  return (
    <main className="narrow stack">
      <div className="card stack">
        <div className="row between">
          <h1>투표율 입력</h1>
          <span className="pill accent">{entered} / {applicable} 투표소 입력됨</span>
        </div>
        <PointPicker config={config} value={point} onChange={setPoint} following={following} isLive={isLive} onResetToLive={resetToLive} />
        {config.roster_active && <div className="alert warn">비상 손 입력 · 선거인명부 체크로 자동 집계 중입니다. 시스템 장애로 대조가 불가능할 때만 쓰고, 입력값은 로그에 남습니다.</div>}
        {locked && <div className="alert danger">총관리자가 입력을 잠갔습니다. 지금은 입력할 수 없습니다.</div>}
        {config.election.enforce_time_window && Date.now() < slotEpoch(point.date, point.time) - 10 * 60 * 1000 && (
          <div className="alert warn">이 시점은 집계 시각 10분 전부터 입력할 수 있습니다.</div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 6 }}>{pointLabel(point)} 기준 투표소</h2>
        <p className="muted small" style={{ marginBottom: 8 }}>투표소를 누르면 누적 투표자수를 입력합니다. 이미 입력된 값은 확정 전까지 덮어쓸 수 있습니다.</p>
        <div className="list">
          {rows.map((r) => (
            <motion.div
              key={r.station.id} layout className="list-item" style={{ opacity: r.slotId ? 1 : 0.45, cursor: r.slotId ? 'pointer' : 'default' }}
              onClick={() => { if (r.slotId && !locked) setActive(r); }}
              whileTap={r.slotId ? { scale: 0.99 } : undefined}
            >
              <div>
                <div className="title">{r.station.name}</div>
                <div className="sub">{r.districtName !== r.station.name ? r.districtName + ' · ' : ''}{r.slotId ? (r.entry ? `${r.entry.entered_by_name} · ${fmtTime(r.entry.entered_at)}` : '미입력') : '이 시점은 집계하지 않음'}</div>
              </div>
              <div className="right">
                {r.entry ? (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 18 }}>{fmtNum(r.entry.cumulative)}명</div>
                    <div className="small">{r.entry.confirmed ? <span className="pill good">확정</span> : <span className="pill muted">확정 전</span>}</div>
                  </>
                ) : r.slotId ? <span className="pill danger">미입력</span> : null}
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      <Sheet open={!!active} onClose={() => setActive(null)} title={active ? `${active.station.name} · ${pointLabel(point)}` : undefined}>
        {active && (
          <EntryForm row={active} point={point} entries={entries} onDone={() => { setActive(null); reload(); }} />
        )}
      </Sheet>
    </main>
  );
}

function EntryForm({ row, point, entries, onDone }: { row: Row; point: Point; entries: Entry[]; onDone: () => void }) {
  const { config, me } = useStore();
  const [cum, setCum] = useState(row.entry ? String(row.entry.cumulative) : '');
  const [leave, setLeave] = useState(row.entry ? String(row.entry.leave_cumulative) : '0');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [overwriteOf, setOverwriteOf] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const epoch = slotEpoch(point.date, point.time);
  // 이 투표소의 직전 시점 값
  const prev = useMemo(() => {
    if (!config) return null;
    let best: { e: Entry; epoch: number } | null = null;
    for (const e of entries) {
      if (e.station_id !== row.station.id) continue;
      const slot = config.slots.find((s) => s.id === e.slot_id);
      const day = slot && config.days.find((d) => d.id === slot.day_id);
      if (!slot || !day) continue;
      const ep = slotEpoch(day.date, slot.time);
      if (ep < epoch && (!best || ep > best.epoch)) best = { e, epoch: ep };
    }
    return best?.e ?? null;
  }, [config, entries, row.station.id, epoch]);

  const c = Number(cum), l = Number(leave);
  const valid = cum !== '' && Number.isInteger(c) && c >= 0 && Number.isInteger(l) && l >= 0 && l <= c;
  const decreased = valid && prev !== null && c < prev.cumulative;

  // 선거구 투표율 미리보기 (다른 투표소는 이 시점 기준 최신값 이어쓰기)
  const preview = useMemo(() => {
    if (!config || !valid) return null;
    const district = config.districts.find((d) => d.id === row.station.district_id);
    if (!district) return null;
    let cumSum = c, leaveSum = l;
    for (const st of config.stations.filter((s) => s.district_id === district.id && s.id !== row.station.id)) {
      let latest: { e: Entry; epoch: number } | null = null;
      for (const e of entries.filter((x) => x.station_id === st.id)) {
        const slot = config.slots.find((s) => s.id === e.slot_id);
        const day = slot && config.days.find((d) => d.id === slot.day_id);
        if (!slot || !day) continue;
        const ep = slotEpoch(day.date, slot.time);
        if (ep <= epoch && (!latest || ep > latest.epoch)) latest = { e, epoch: ep };
      }
      if (latest) { cumSum += latest.e.cumulative; leaveSum += latest.e.leave_cumulative; }
    }
    const voters = district.base_voters + leaveSum;
    return { district, voters, cumSum, pct: voters > 0 ? (cumSum / voters) * 100 : 0 };
  }, [config, valid, c, l, entries, row.station, epoch]);

  const confirmedForMember = !!row.entry?.confirmed && me?.role !== 'admin';

  const save = async (e?: FormEvent, overwrite = false) => {
    e?.preventDefault();
    if (!valid || !row.slotId) return;
    setBusy(true); setError(null);
    try {
      await api('/entries', { body: { station_id: row.station.id, slot_id: row.slotId, cumulative: c, leave_cumulative: l, overwrite } });
      setDone('저장되었습니다.');
      setTimeout(onDone, 500);
    } catch (err) {
      const ae = err as ApiError;
      if (ae.code === 'exists') setOverwriteOf(ae.extra?.entry ?? null);
      else setError(ae.message);
    } finally { setBusy(false); }
  };

  const request = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !row.entry) return;
    setBusy(true); setError(null);
    try {
      await api('/change-requests', { body: { entry_id: row.entry.id, new_cumulative: c, new_leave_cumulative: l, reason } });
      setDone('수정요청을 보냈습니다. 총관리자 승인 후 반영됩니다.');
      setTimeout(onDone, 900);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <form className="stack" onSubmit={confirmedForMember ? request : (e) => save(e, false)}>
      {row.entry && (
        <div className={`alert ${row.entry.confirmed ? 'info' : 'warn'}`}>
          현재 값 {fmtNum(row.entry.cumulative)}명 (휴학생 {fmtNum(row.entry.leave_cumulative)}명) · {row.entry.entered_by_name} · {fmtTime(row.entry.entered_at)}
          {row.entry.confirmed ? (me?.role === 'admin' ? ' · 확정됨 (관리자 직접 수정은 로그에 남습니다)' : ' · 확정됨: 수정요청으로만 바꿀 수 있습니다') : ''}
        </div>
      )}
      {prev && <p className="muted small">직전 시점 누적 {fmtNum(prev.cumulative)}명 (휴학생 {fmtNum(prev.leave_cumulative)}명)</p>}
      <div className="field">
        <label htmlFor="cum">누적 투표자수 (휴학생 포함)</label>
        <input id="cum" className="input big" inputMode="numeric" pattern="[0-9]*" value={cum} onChange={(e) => setCum(e.target.value.replace(/[^0-9]/g, ''))} autoFocus placeholder="0" />
      </div>
      <div className="field">
        <label htmlFor="leave">그중 휴학생 투표자수 (누적)</label>
        <input id="leave" className="input" inputMode="numeric" pattern="[0-9]*" value={leave} onChange={(e) => setLeave(e.target.value.replace(/[^0-9]/g, ''))} />
      </div>
      {valid && l > c && <div className="alert danger">휴학생 수는 누적 투표자수를 넘을 수 없습니다.</div>}
      {preview && (
        <div className="card" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
          <div className="row between">
            <span className="muted small">{preview.district.name} 투표율 미리보기</span>
            <span style={{ fontWeight: 700 }}>{fmtPct(preview.pct)}</span>
          </div>
          <div className="small muted">{fmtNum(preview.cumSum)}명 / {fmtNum(preview.voters)}명{prev ? ` · 이 투표소 증가분 ${fmtNum(c - prev.cumulative)}명` : ''}</div>
        </div>
      )}
      {decreased && <div className="alert warn">직전 시점({fmtNum(prev!.cumulative)}명)보다 줄어든 값입니다. 숫자를 다시 확인하세요. 그래도 저장할 수 있습니다.</div>}
      {confirmedForMember && (
        <div className="field">
          <label htmlFor="reason">수정 사유</label>
          <textarea id="reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 서명부 재집계 결과 오타 확인" required />
        </div>
      )}
      {overwriteOf && (
        <div className="alert warn stack">
          <div>{overwriteOf.entered_by_name}님이 이미 {fmtNum(overwriteOf.cumulative)}명으로 입력했습니다. 덮어쓸까요? (변경 로그에 남습니다)</div>
          <div className="row">
            <button type="button" className="btn danger" disabled={busy} onClick={() => save(undefined, true)}>덮어쓰기</button>
            <button type="button" className="btn" onClick={() => setOverwriteOf(null)}>취소</button>
          </div>
        </div>
      )}
      {error && <div className="alert danger" role="alert">{error}</div>}
      {done ? <div className="alert good">{done}</div> : (
        <button className="btn primary block" disabled={busy || !valid || (confirmedForMember && !reason.trim())}>
          {busy ? '저장 중…' : confirmedForMember ? '수정요청 보내기' : decreased ? '줄어든 값으로 저장' : '저장'}
        </button>
      )}
    </form>
  );
}
