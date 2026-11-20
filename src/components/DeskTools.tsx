import React, { useEffect, useState, type FormEvent } from 'react';
import { api, DEPT_SEP, ISSUE_CHOICES, ISSUE_TYPES, type DeskList, type IssueType } from '../apis';

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
  // 학과별로 묶는다: "학과 > 전공"의 앞부분이 같은 것끼리
  const groups: [string, typeof free][] = [];
  for (const d of free) {
    const upper = d.name.split(DEPT_SEP)[0];
    const g = groups.find((x) => x[0] === upper);
    if (g) g[1].push(d); else groups.push([upper, [d]]);
  }
  const toggle = (names: string[], on: boolean) => onChange({ depts: on ? [...new Set([...picked, ...names])] : picked.filter((x) => !names.includes(x)) });
  const chip = (key: string, label: string, on: boolean, onClick: () => void, strong = false) => (
    <button key={key} type="button" aria-pressed={on} className={`chip ${on ? 'active' : ''}`} style={{ minHeight: 40, fontSize: 15, fontWeight: strong ? 700 : undefined, alignSelf: 'flex-start' }} onClick={onClick}>
      {on ? '✓ ' : ''}{label}
    </button>
  );
  // .field label(작은 회색 글씨)·.row(줄바꿈)·.stack(여백) 규칙을 타지 않도록 전용 마크업을 쓴다
  const Option = ({ on, onPick, title, sub, children }: { on: boolean; onPick: () => void; title: string; sub?: string; children?: React.ReactNode }) => (
    <div style={{ border: `2px solid ${on ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 12, background: on ? 'var(--surface)' : 'var(--surface-2)', overflow: 'hidden' }}>
      <button type="button" role="radio" aria-checked={on} onClick={onPick}
        style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 52, padding: '10px 14px', background: 'none', border: 0, textAlign: 'left', font: 'inherit', color: 'var(--text)', cursor: 'pointer' }}>
        <span aria-hidden style={{ flex: 'none', width: 20, height: 20, borderRadius: '50%', border: `2px solid ${on ? 'var(--accent)' : 'var(--muted)'}`, display: 'grid', placeItems: 'center' }}>
          {on && <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--accent)' }} />}
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 16, fontWeight: 700, lineHeight: 1.35, wordBreak: 'keep-all' }}>{title}</span>
          {sub && <span style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>{sub}</span>}
        </span>
      </button>
      {children}
    </div>
  );
  return (
    <div role="radiogroup" aria-label="창구">
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>창구</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.desks.filter((d) => !d.is_unassigned).map((d) => (
          <Option key={d.id} on={!!value && 'desk_id' in value && value.desk_id === d.id} onPick={() => onChange({ desk_id: d.id })}
            title={`${d.name} 창구`} sub={`${d.id === currentId ? '이 기기의 창구 · ' : ''}지금 기기 ${d.device_count}대`} />
        ))}
        {free.length > 0 && (
          <Option on={isNew} onPick={() => onChange({ depts: picked })} title="새 창구 만들기" sub="이 창구가 맡는 학과를 모두 고르세요">
            {isNew && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 14px 14px' }}>
                {groups.map(([upper, items]) => {
                  const names = items.map((d) => d.name);
                  const allOn = names.every((n) => picked.includes(n));
                  // 전공이 없는 학과는 칩 하나. 전공이 있으면 "학과 전체" 칩과 전공 칩들
                  if (items.length === 1 && !names[0].includes(DEPT_SEP)) return chip(names[0], upper || '(학과 미기재)', allOn, () => toggle(names, !allOn));
                  return (
                    <div key={upper} style={{ borderLeft: '3px solid var(--border)', paddingLeft: 10 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {chip(`${upper}-all`, `${upper} 전체`, allOn, () => toggle(names, !allOn), true)}
                        {items.map((d) => chip(d.name, d.name.split(DEPT_SEP)[1] ?? '전공 없음', picked.includes(d.name), () => toggle([d.name], !picked.includes(d.name))))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Option>
        )}
        {!list.desks.some((d) => d.is_all) && (
          <Option on={!!value && 'all' in value} onPick={() => onChange({ all: true })} title="전체" sub="학과 구분 없이 한 줄로 운영" />
        )}
      </div>
    </div>
  );
}
export const deskChoiceReady = (v: DeskChoice) => !!v && (!('depts' in v) || v.depts.length > 0);

/** 꼬리표 이슈 신고 (FR-104) */
export function IssueForm({ stationId, deskId, onDone }: { stationId: string; deskId?: string; onDone: () => void }) {
  const [type, setType] = useState<IssueType>('lost');
  const [serial, setSerial] = useState('');
  const [count, setCount] = useState('1');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api('/roster/issues', { body: { type, serial_from: serial || undefined, count: Number(count || 1), note, station_id: stationId, desk_id: deskId } });
      onDone();
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div className="field">
        <label htmlFor="is-type">유형</label>
        <select id="is-type" className="input" value={type} onChange={(e) => setType(e.target.value as IssueType)}>
          {ISSUE_CHOICES.map((t) => <option key={t} value={t}>{ISSUE_TYPES[t]}</option>)}
        </select>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}><label htmlFor="is-count">장수</label><input id="is-count" className="input" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))} /></div>
        <div className="field" style={{ flex: 2 }}><label htmlFor="is-serial">용지 번호 (알 때만)</label><input id="is-serial" className="input" inputMode="numeric" value={serial} onChange={(e) => setSerial(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} placeholder="예: 000104" /></div>
      </div>
      <div className="field"><label htmlFor="is-note">메모{type === 'other' ? ' (필수)' : ''}</label><input id="is-note" className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="예: 3번째 장 꼬리표가 반쯤 찢어짐" /></div>
      <p className="muted small" style={{ margin: 0 }}>신고는 기록으로만 남고 대조 숫자를 바꾸지 않습니다. 숫자가 안 맞으면 총관리자에게 조정을 요청하세요.</p>
      {err && <div className="alert danger">{err}</div>}
      <button className="btn primary block" disabled={busy || (type === 'other' && !note.trim())}>이슈 신고</button>
    </form>
  );
}
