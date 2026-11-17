import { useEffect, useState, type FormEvent } from 'react';
import { api, fmtNo, ISSUE_TYPES, type DeskList, type IssueType, type PadInfo } from '../apis';

/** 창구 고르기 (FR-107): 기존 창구, 새 학과 묶음, "전체" 중 하나 */
export type DeskChoice = { desk_id: string } | { depts: string[] } | { all: true } | null;
export function DeskPicker({ currentId, value, onChange }: { currentId?: string | null; value: DeskChoice; onChange: (v: DeskChoice) => void }) {
  const [list, setList] = useState<DeskList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<DeskList>('/roster/desks').then((l) => {
      setList(l);
      if (currentId && l.desks.some((d) => d.id === currentId)) onChange({ desk_id: currentId });
    }).catch((e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (err) return <div className="alert danger">{err}</div>;
  if (!list) return <p className="muted small">창구 목록을 불러오는 중…</p>;
  const free = list.depts.filter((d) => !d.desk_id);
  const picked = value && 'depts' in value ? value.depts : [];
  const isNew = !!value && 'depts' in value;
  const row = { gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)' } as const;
  const box = { width: 20, height: 20, marginTop: 2, flex: 'none' } as const;
  return (
    <div className="field">
      <label>창구</label>
      <div className="stack" style={{ gap: 6 }}>
        {list.desks.filter((d) => !d.is_unassigned).map((d) => (
          <label key={d.id} className="row" style={row}>
            <input type="radio" name="desk" style={box} checked={!!value && 'desk_id' in value && value.desk_id === d.id} onChange={() => onChange({ desk_id: d.id })} />
            <span><strong>{d.name}</strong> 창구<span className="small muted"> · 지금 기기 {d.device_count}대{d.id === currentId ? ' · 이 기기의 창구' : ''}</span></span>
          </label>
        ))}
        {free.length > 0 && (
          <div style={{ ...row, display: 'block' }}>
            <label className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <input type="radio" name="desk" style={box} checked={isNew} onChange={() => onChange({ depts: [] })} />
              <span><strong>새 창구 만들기</strong><span className="small muted"> · 이 창구가 맡는 학과를 고르세요</span></span>
            </label>
            {isNew && (
              <div className="stack" style={{ gap: 4, margin: '8px 0 0 30px' }}>
                {free.map((d) => (
                  <label key={d.name} className="row" style={{ gap: 8 }}>
                    <input type="checkbox" style={{ width: 18, height: 18 }} checked={picked.includes(d.name)}
                      onChange={(e) => onChange({ depts: e.target.checked ? [...picked, d.name] : picked.filter((x) => x !== d.name) })} />
                    {d.name || '(학과 미기재)'}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {!list.desks.some((d) => d.is_all) && (
          <label className="row" style={row}>
            <input type="radio" name="desk" style={box} checked={!!value && 'all' in value} onChange={() => onChange({ all: true })} />
            <span><strong>전체</strong><span className="small muted"> · 학과 구분 없이 한 줄로 운영</span></span>
          </label>
        )}
      </div>
    </div>
  );
}
export const deskChoiceReady = (v: DeskChoice) => !!v && (!('depts' in v) || v.depts.length > 0);

/** 묶음 추가·받기 (FR-100, FR-100a) */
export function PadForm({ mode, stationId, deskId, onDone }: { mode: 'add' | 'receive'; stationId: string; deskId?: string; onDone: () => void }) {
  const [no, setNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await api(mode === 'add' ? '/roster/pads' : '/roster/pads/receive', { body: { first_no: no, station_id: stationId, desk_id: deskId } }); onDone(); }
    catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const n = Number(no);
  const first = no && n >= 1 ? Math.floor((n - 1) / 100) * 100 + 1 : null;
  return (
    <form className="stack" onSubmit={submit}>
      <p className="muted small" style={{ margin: 0 }}>
        {mode === 'add' ? '새 묶음을 쓰기 직전에 등록합니다. 묶음 맨 앞 용지의 번호(…01로 끝남)를 넣으세요. 앞의 0은 빼도 됩니다.'
          : '다른 창구가 쓰던 묶음을 통째로 가져올 때 씁니다. 그 묶음의 아무 번호나 넣으면 됩니다. 직전 마감 번호가 이어집니다.'}
      </p>
      <div className="field">
        <label htmlFor="pad-no">{mode === 'add' ? '첫 번호' : '묶음의 번호'}</label>
        <input id="pad-no" className="input big" inputMode="numeric" autoFocus value={no} onChange={(e) => setNo(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} placeholder={mode === 'add' ? '예: 000101' : '예: 000137'} />
      </div>
      {first !== null && (mode === 'receive' || n % 100 === 1) && <div className="small muted">묶음 {fmtNo(first)}~{fmtNo(first + 99)}</div>}
      {err && <div className="alert danger">{err}</div>}
      <button className="btn primary block" disabled={busy || !no}>{mode === 'add' ? '묶음 추가' : '묶음 받기'}</button>
    </form>
  );
}

/** 꼬리표 이슈 신고 (FR-104) */
export function IssueForm({ stationId, deskId, pads, onDone }: { stationId: string; deskId?: string; pads: PadInfo[]; onDone: () => void }) {
  const [type, setType] = useState<IssueType>('lost');
  const [padId, setPadId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [count, setCount] = useState('1');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const digits = (v: string) => v.replace(/[^0-9]/g, '').slice(0, 6);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api('/roster/issues', { body: { type, pad_id: padId || undefined, serial_from: from || undefined, serial_to: to || undefined, count: to ? undefined : Number(count || 1), note, station_id: stationId, desk_id: deskId } });
      onDone();
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div className="field">
        <label htmlFor="is-type">유형</label>
        <select id="is-type" className="input" value={type} onChange={(e) => setType(e.target.value as IssueType)}>
          {(Object.keys(ISSUE_TYPES) as IssueType[]).map((t) => <option key={t} value={t}>{ISSUE_TYPES[t]}</option>)}
        </select>
      </div>
      {pads.length > 0 && (
        <div className="field">
          <label htmlFor="is-pad">묶음 (선택)</label>
          <select id="is-pad" className="input" value={padId} onChange={(e) => setPadId(e.target.value)}>
            <option value="">모름 / 해당 없음</option>
            {pads.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}><label htmlFor="is-from">일련번호 (알 때만)</label><input id="is-from" className="input" inputMode="numeric" value={from} onChange={(e) => setFrom(digits(e.target.value))} placeholder="예: 000104" /></div>
        <div className="field" style={{ flex: 1 }}><label htmlFor="is-to">~ 끝 번호 (여러 장)</label><input id="is-to" className="input" inputMode="numeric" value={to} onChange={(e) => setTo(digits(e.target.value))} /></div>
      </div>
      {!to && <div className="field"><label htmlFor="is-count">장수</label><input id="is-count" className="input" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))} /></div>}
      <div className="field"><label htmlFor="is-note">메모{type === 'other' ? ' (필수)' : ''}</label><input id="is-note" className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="예: 3번째 장 꼬리표가 반쯤 찢어짐" /></div>
      <p className="muted small" style={{ margin: 0 }}>신고는 기록으로만 남고 대조 숫자를 바꾸지 않습니다. 숫자가 안 맞으면 총관리자에게 조정을 요청하세요.</p>
      {err && <div className="alert danger">{err}</div>}
      <button className="btn primary block" disabled={busy || (type === 'other' && !note.trim())}>이슈 신고</button>
    </form>
  );
}

/** 마감 때 묶음별 마지막 번호 입력 (FR-101, FR-103) */
export type ReadingState = Record<string, { mode: 'no' | 'count' | 'unused'; value: string }>;
const usedOf = (p: PadInfo, r?: ReadingState[string]): number | null => {
  if (!r) return null;
  if (r.mode === 'unused') return p.used_total;
  if (!r.value) return null;
  const n = Number(r.value);
  if (r.mode === 'count') return n >= p.used_total && n <= p.last_no - p.first_no + 1 ? n : null;
  return n >= p.first_no && n <= p.last_no && n - p.first_no + 1 >= p.used_total ? n - p.first_no + 1 : null;
};
/** 모든 묶음에 올바른 값이 들어갔을 때의 이번 구간 꼬리표 수 (아니면 null) */
export function readingsTotal(pads: PadInfo[], state: ReadingState): number | null {
  let sum = 0;
  for (const p of pads) { const u = usedOf(p, state[p.id]); if (u === null) return null; sum += u - p.used_total; }
  return sum;
}
export const readingsBody = (pads: PadInfo[], state: ReadingState) => pads.map((p) => {
  const r = state[p.id];
  return r?.mode === 'unused' ? { pad_id: p.id, unused: true } : r?.mode === 'count' ? { pad_id: p.id, count: Number(r.value) } : { pad_id: p.id, last_no: r?.value ?? '' };
});
export function ReadingInputs({ pads, value, onChange }: { pads: PadInfo[]; value: ReadingState; onChange: (v: ReadingState) => void }) {
  const set = (id: string, r: ReadingState[string]) => onChange({ ...value, [id]: r });
  return (
    <div className="stack" style={{ gap: 10 }}>
      {pads.map((p, i) => {
        const r = value[p.id] ?? { mode: 'no' as const, value: '' };
        const used = usedOf(p, value[p.id]);
        const bad = r.mode !== 'unused' && r.value !== '' && used === null;
        return (
          <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
            <div className="row between">
              <strong>묶음 {p.label}</strong>
              <span className="small muted">직전 마감 {p.used_total > 0 ? (p.by_count || p.used_no === null ? `${p.used_total}장` : fmtNo(p.used_no)) : '없음'}</span>
            </div>
            {r.mode === 'unused' ? (
              <div className="row between" style={{ marginTop: 8 }}>
                <span className="muted">이번 구간에 안 씀</span>
                <button type="button" className="btn sm ghost" onClick={() => set(p.id, { mode: 'no', value: '' })}>번호 입력</button>
              </div>
            ) : (
              <>
                <div className="field" style={{ marginTop: 8 }}>
                  <label htmlFor={`rd-${p.id}`}>{r.mode === 'count' ? '묶음에 남은 꼬리표 수 (처음부터 전부)' : '마지막으로 뗀 번호'}</label>
                  <input id={`rd-${p.id}`} className="input big" inputMode="numeric" autoFocus={i === 0} value={r.value}
                    onChange={(e) => set(p.id, { mode: r.mode, value: e.target.value.replace(/[^0-9]/g, '').slice(0, 6) })}
                    placeholder={r.mode === 'count' ? '예: 37' : `예: ${fmtNo(Math.min(p.last_no, p.first_no + Math.max(p.used_total, 1) + 9))}`} />
                </div>
                {bad && <div className="small" style={{ color: 'var(--danger)' }}>{r.mode === 'count' ? `${p.used_total}~${p.last_no - p.first_no + 1} 사이의 장수를 넣으세요.` : `이 묶음의 번호(${p.label})이고 직전 마감보다 작지 않아야 합니다.`}</div>}
                {used !== null && <div className="small muted">이번 구간 {used - p.used_total}장{used === p.last_no - p.first_no + 1 ? ' · 묶음을 다 씀' : ''}</div>}
                <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="btn sm ghost" onClick={() => set(p.id, { mode: 'unused', value: '' })}>안 씀</button>
                  <button type="button" className="btn sm ghost" onClick={() => set(p.id, { mode: 'no', value: String(p.last_no) })}>다 씀</button>
                  <button type="button" className="btn sm ghost" onClick={() => set(p.id, { mode: r.mode === 'count' ? 'no' : 'count', value: '' })}>{r.mode === 'count' ? '번호로 입력' : '번호를 읽을 수 없음'}</button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
