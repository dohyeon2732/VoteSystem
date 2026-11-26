import { useEffect, useState } from 'react';
import { api, fmtNum, fmtPct, fmtTime } from '../apis';
import { useStore } from '../app/store';

type Saved = { voters: number | null; tags: number | null; agree: number | null; oppose: number | null; invalid: number | null; counted_at: string | null; updated_at: string; updated_by: string };
type Row = { id: string; name: string; system_voted: number; result: Saved | null };
type Draft = { agree: string; oppose: string; invalid: string; voters: string; tags: string };
/** 개표 결과가 저장된 줄 */
const counted = (r: Row) => r.result?.agree != null;
/** 꼬리표 수와 투표 인원이 저장돼 있고 일치하는 줄 */
const tagOk = (r: Row) => r.result?.tags != null && r.result.tags === votersOf(r);

const pctOf = (c: number, v: number) => (v > 0 ? Math.round((c / v) * 10000) / 100 : 0);
/** 그 줄의 투표 인원: 저장한 값이 있으면 그 값, 없으면 시스템 체크 인원 */
const votersOf = (r: Row) => r.result?.voters ?? r.system_voted;

/**
 * 확정 순간 (FR-133): 개표 결과를 처음 저장한 순서대로 누적해, 남은 줄의 표가 모두 반대(또는 찬성)여도 뒤집히지 않는 첫 줄.
 */
export function decide(rows: Row[]): { kind: 'win' | 'lose'; row: Row; agree: number; oppose: number; remaining: number } | null {
  const done = rows.filter(counted).sort((a, b) => (a.result!.counted_at ?? '').localeCompare(b.result!.counted_at ?? ''));
  const all = rows.reduce((a, r) => a + votersOf(r), 0);
  let agree = 0, oppose = 0, seen = 0;
  for (const r of done) {
    agree += r.result!.agree ?? 0; oppose += r.result!.oppose ?? 0; seen += votersOf(r);
    const remaining = all - seen;
    if (agree > oppose + remaining) return { kind: 'win', row: r, agree, oppose, remaining };
    if (oppose >= agree + remaining) return { kind: 'lose', row: r, agree, oppose, remaining };
  }
  return null;
}

/** 개표 집계 (FR-133). 총관리자만. */
export default function AdminCount() {
  const { config } = useStore();
  const th = config?.election.threshold_pct ?? 50;
  const [data, setData] = useState<{ rows: Row[]; eligible: number; ready: boolean } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const load = async () => {
    try { setData(await api<{ rows: Row[]; eligible: number; ready: boolean }>('/count')); }
    catch (e) { setErr(e instanceof Error ? e.message : '불러오지 못했습니다.'); }
  };
  useEffect(() => { void load(); }, []);
  if (!data) return <main><p className="muted center">{err || '불러오는 중…'}</p></main>;

  const rows = data.rows;
  const str = (v: number | null | undefined) => (v == null ? '' : String(v));
  const draftOf = (r: Row): Draft => drafts[r.id] ?? {
    agree: str(r.result?.agree), oppose: str(r.result?.oppose), invalid: str(r.result?.invalid), voters: String(votersOf(r)), tags: str(r.result?.tags),
  };
  const edit = (r: Row, k: keyof Draft, v: string) => setDrafts({ ...drafts, [r.id]: { ...draftOf(r), [k]: v.replace(/[^0-9]/g, '') } });
  const n = (s: string) => (s === '' ? 0 : Number(s));
  /** withResult가 false면 꼬리표 확인(투표 인원·꼬리표 수)만 저장한다 */
  const save = async (r: Row, withResult: boolean) => {
    const d = draftOf(r);
    setBusy(r.id); setErr('');
    try {
      await api(`/count/${r.id}`, { method: 'PUT', body: { voters: n(d.voters), tags: n(d.tags), ...(withResult ? { agree: n(d.agree), oppose: n(d.oppose), invalid: n(d.invalid) } : {}) } });
      const next = { ...drafts }; delete next[r.id]; setDrafts(next);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : '저장하지 못했습니다.'); }
    finally { setBusy(''); }
  };

  const done = rows.filter(counted);
  const sum = (f: (r: Row) => number) => done.reduce((a, r) => a + f(r), 0);
  const agree = sum((r) => r.result!.agree ?? 0), oppose = sum((r) => r.result!.oppose ?? 0), invalid = sum((r) => r.result!.invalid ?? 0);
  const abstain = sum((r) => votersOf(r) - (r.result!.agree ?? 0) - (r.result!.oppose ?? 0) - (r.result!.invalid ?? 0));
  const votersAll = rows.reduce((a, r) => a + votersOf(r), 0), eligibleAll = data.eligible, tagsAll = rows.reduce((a, r) => a + (r.result?.tags ?? 0), 0);
  const turnout = pctOf(votersAll, eligibleAll), turnoutOk = turnout >= th;
  const remaining = votersAll - sum(votersOf);
  const dec = decide(rows);
  const allDone = done.length === rows.length && rows.length > 0;
  const final = !allDone ? null : !turnoutOk ? '투표율 미달' : agree > oppose ? '가결' : '부결';

  const copy = async () => {
    const lines = rows.map((r) => {
      const v = votersOf(r), x = r.result, c = counted(r);
      return [r.name, v, x?.tags ?? '', c ? x!.agree : '', c ? x!.oppose : '', c ? x!.invalid : '', c ? v - x!.agree! - x!.oppose! - x!.invalid! : ''].join('\t');
    });
    lines.push(['합계', votersAll, tagsAll, agree, oppose, invalid, abstain].join('\t'));
    await navigator.clipboard.writeText(['개표 단위\t투표 인원\t꼬리표 수\t찬성\t반대\t무효\t기권', ...lines].join('\n'));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  const num = { width: 84, textAlign: 'right' as const };

  return (
    <main className="stack">
      <div className="card stack">
        <div className="row between"><h1>개표</h1><span className="pill muted">개표 완료 {done.length} / {rows.length}</span></div>
        <p className="muted small">먼저 꼬리표 수를 넣고 확인합니다. 투표 인원과 일치해야 찬성·반대·무효를 넣을 수 있습니다. 기권은 자동으로 계산합니다. 투표 인원은 시스템 체크 인원이 기본이고 고칠 수 있습니다. 총관리자만 볼 수 있습니다.</p>
        {!data.ready && <div className="alert danger small">개표 값을 저장할 표가 아직 없습니다. Supabase SQL 편집기에서 schema.sql을 다시 실행해야 저장됩니다.</div>}
        {err && <div className="alert danger small">{err}</div>}
        {dec && (dec.kind === 'lose' || turnoutOk) && (
          <div className={`alert ${dec.kind === 'win' ? 'good' : 'danger'} small`}>
            <b>{dec.kind === 'win' ? '당선 확정' : '부결 확정'}</b> · {dec.row.name} 입력 시점 ({fmtTime(dec.row.result!.counted_at ?? dec.row.result!.updated_at)}) · 찬성 {fmtNum(dec.agree)}표 / 반대 {fmtNum(dec.oppose)}표 · 남은 표 {fmtNum(dec.remaining)}표
          </div>
        )}
        {dec?.kind === 'win' && !turnoutOk && <div className="alert warn small">찬성이 앞서 뒤집히지 않지만 투표율이 기준 {th}%에 못 미칩니다 (투표율 {fmtPct(turnout)}).</div>}
        <div className={`alert ${final === '가결' ? 'good' : final ? 'danger' : 'warn'} small`}>
          {final ? <b>최종: {final}</b> : <b>개표 중</b>} · 찬성 {fmtNum(agree)} · 반대 {fmtNum(oppose)} · 무효 {fmtNum(invalid)} · 기권 {fmtNum(abstain)}
          {agree + oppose > 0 && ` · 찬성률 ${fmtPct(pctOf(agree, agree + oppose))}`} · 투표율 {fmtPct(turnout)} · 남은 표 {fmtNum(remaining)}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>개표 단위</th><th>투표 인원</th><th>꼬리표 수</th><th>찬성</th><th>반대</th><th>무효</th><th>기권</th><th></th><th>수정</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const d = draftOf(r), dirty = !!drafts[r.id];
                const savedV = r.result ? String(votersOf(r)) : null, savedT = str(r.result?.tags);
                // 투표 인원·꼬리표 수가 저장된 값 그대로이고 일치할 때만 개표 칸을 연다
                const open = tagOk(r) && d.voters === savedV && d.tags === savedT;
                const match = d.tags !== '' && n(d.tags) === n(d.voters);
                const filled = d.agree !== '' && d.oppose !== '' && d.invalid !== '';
                const left = n(d.voters) - n(d.agree) - n(d.oppose) - n(d.invalid);
                const input = (k: keyof Draft, label: string, disabled = false) => (
                  <input className="input mono" style={num} inputMode="numeric" aria-label={`${r.name} ${label}`} disabled={disabled} value={d[k]} onChange={(e) => edit(r, k, e.target.value)} />
                );
                return (
                  <tr key={r.id}>
                    <td>{r.name}{counted(r) && !dirty && <span className="pill good" style={{ marginLeft: 6 }}>완료</span>}</td>
                    <td>{input('voters', '투표 인원')}{n(d.voters) !== r.system_voted && <div className="small muted">수정됨 (시스템 {fmtNum(r.system_voted)})</div>}</td>
                    <td>{input('tags', '꼬리표 수')}{d.tags !== '' && <div className="small"><span className={`pill ${match ? 'good' : 'danger'}`}>{match ? '일치' : `불일치 ${n(d.tags) - n(d.voters) > 0 ? '+' : '−'}${fmtNum(Math.abs(n(d.tags) - n(d.voters)))}`}</span></div>}</td>
                    <td>{input('agree', '찬성', !open)}</td>
                    <td>{input('oppose', '반대', !open)}</td>
                    <td>{input('invalid', '무효', !open)}</td>
                    <td className="mono">{open && filled ? (left < 0 ? <span className="pill danger">표가 {fmtNum(-left)} 많음</span> : fmtNum(left)) : ''}</td>
                    <td>
                      {open
                        ? <button className="btn sm primary" disabled={!filled || busy === r.id || (!dirty && counted(r))} onClick={() => save(r, true)}>{busy === r.id ? '저장 중…' : counted(r) ? '수정 저장' : '저장'}</button>
                        : <button className="btn sm" disabled={d.tags === '' || d.voters === '' || busy === r.id} onClick={() => save(r, false)}>{busy === r.id ? '저장 중…' : '꼬리표 확인'}</button>}
                    </td>
                    <td className="small muted">{r.result ? `${r.result.updated_by} · ${fmtTime(r.result.updated_at)}` : ''}</td>
                  </tr>
                );
              })}
              <tr>
                <td><b>합계</b></td><td className="mono"><b>{fmtNum(votersAll)}</b></td><td className="mono"><b>{fmtNum(tagsAll)}</b></td><td className="mono"><b>{fmtNum(agree)}</b></td><td className="mono"><b>{fmtNum(oppose)}</b></td>
                <td className="mono"><b>{fmtNum(invalid)}</b></td><td className="mono"><b>{fmtNum(abstain)}</b></td><td></td><td></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="row between">
          <span className="muted small">유권자수 {fmtNum(eligibleAll)}명 · 기준 투표율 {th}%</span>
          <button className="btn sm" onClick={copy}>{copied ? '복사했습니다' : '표 복사 (엑셀용)'}</button>
        </div>
      </div>
    </main>
  );
}
