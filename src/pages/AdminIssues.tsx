import { useState } from 'react';
import { api, deptLabel, fmtNo, fmtTime, ISSUE_TYPES, type DeskInfo, type DeskList, type IssueType, type TagIssueRow } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import Sheet from '../components/Sheet';
import { downloadText, toCsv } from '../data/sheet';

interface PadRow { id: string; station_id: string; desk_id: string; first_no: number; last_no: number; used_no: number | null; used_total: number; by_count: boolean; opened_at: string; opened_by: string; exhausted_at: string | null }
interface PadData { pads: PadRow[]; desks: DeskInfo[]; moves: { id: string; pad_id: string; from_desk_id: string; to_desk_id: string; at: string; operator_name: string }[]; pad_size: number; serial_max: number }

/** S-15 꼬리표 이슈·묶음 현황·창구 관리 (FR-105, FR-100b, FR-107) */
export default function AdminIssues() {
  const { config } = useStore();
  const issues = usePolling(() => api<{ issues: TagIssueRow[] }>('/roster/issues'), 20000, []);
  const pads = usePolling(() => api<PadData>('/pads'), 20000, []);
  const [fStation, setFStation] = useState('');
  const [fType, setFType] = useState('');
  const [showVoided, setShowVoided] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [padEdit, setPadEdit] = useState<PadRow | null>(null);
  const [padForm, setPadForm] = useState({ used_total: '', desk_id: '', reason: '' });
  const [deskStation, setDeskStation] = useState('');
  const [deskList, setDeskList] = useState<DeskList | null>(null);
  const [newDepts, setNewDepts] = useState<string[]>([]);

  if (!config) return <main><p className="muted center">불러오는 중…</p></main>;
  const sname = (id: string) => config.stations.find((s) => s.id === id)?.name ?? '?';
  const desks = pads.data?.desks ?? [];
  const dname = (id: string | null) => desks.find((d) => d.id === id)?.name ?? '-';
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setMsg(null);
    try { await fn(); await Promise.all([issues.reload(), pads.reload()]); if (done) setMsg({ ok: true, text: done }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const serial = (i: TagIssueRow) => (i.serial_from === null ? '' : i.serial_to !== null && i.serial_to !== i.serial_from ? `${fmtNo(i.serial_from)}~${fmtNo(i.serial_to)}` : fmtNo(i.serial_from));
  const all = issues.data?.issues ?? [];
  const list = all.filter((i) => (!fStation || i.station_id === fStation) && (!fType || i.type === fType) && (showVoided || !i.voided_at));
  const live = all.filter((i) => !i.voided_at);
  const exportCsv = () => downloadText('꼬리표_이슈.csv', toCsv([
    ['시각', '투표소', '창구', '유형', '묶음', '일련번호', '장수', '메모', '담당자', '확인', '확인자', '무효', '무효 사유'],
    ...all.map((i) => [fmtTime(i.at), sname(i.station_id), i.desk_name ?? '', ISSUE_TYPES[i.type], i.pad_label ?? '', serial(i), i.count, i.note ?? '', i.operator_name,
      i.reviewed_at ? '확인' : '미확인', i.reviewed_by ?? '', i.voided_at ? '무효' : '', i.void_reason ?? '']),
  ]));
  const voidIssue = (i: TagIssueRow) => {
    const reason = window.prompt('무효로 처리하는 사유를 적어 주세요.');
    if (reason?.trim()) run(() => api(`/roster/issues/${i.id}/void`, { body: { reason } }));
  };

  // 묶음 현황: 등록되지 않은 번호대 수
  const padRows = pads.data?.pads ?? [];
  const totalPads = pads.data ? Math.floor(pads.data.serial_max / pads.data.pad_size) : 0;
  const savePad = () => padEdit && run(async () => {
    await api(`/pads/${padEdit.id}`, { method: 'PUT', body: { used_total: padForm.used_total === '' ? undefined : Number(padForm.used_total), desk_id: padForm.desk_id || undefined, reason: padForm.reason } });
    setPadEdit(null);
  }, '묶음을 정정했습니다.');

  const loadDesks = async (stationId: string) => {
    setDeskStation(stationId); setDeskList(null); setNewDepts([]);
    if (stationId) try { setDeskList(await api<DeskList>(`/roster/desks?station_id=${encodeURIComponent(stationId)}`)); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const deskAction = (fn: () => Promise<unknown>, done: string) => run(async () => { await fn(); await loadDesks(deskStation); }, done);

  return (
    <main className="stack">
      {msg && <div className={`alert ${msg.ok ? 'good' : 'danger'}`} role="alert">{msg.text}</div>}
      <div className="card stack">
        <div className="row between">
          <h1>꼬리표 이슈</h1>
          <button className="btn sm" onClick={exportCsv}>이슈 CSV</button>
        </div>
        <div className="chips">
          <span className="chip">전체 {live.length}건</span>
          <span className="chip">미확인 {live.filter((i) => !i.reviewed_at).length}건</span>
          {(Object.keys(ISSUE_TYPES) as IssueType[]).map((t) => { const n = live.filter((i) => i.type === t).length; return n ? <span key={t} className="chip">{ISSUE_TYPES[t]} {n}</span> : null; })}
        </div>
        <div className="form-row">
          <div className="field"><label htmlFor="f-st">투표소</label>
            <select id="f-st" className="input" value={fStation} onChange={(e) => setFStation(e.target.value)}><option value="">전체</option>{config.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          <div className="field"><label htmlFor="f-ty">유형</label>
            <select id="f-ty" className="input" value={fType} onChange={(e) => setFType(e.target.value)}><option value="">전체</option>{(Object.keys(ISSUE_TYPES) as IssueType[]).map((t) => <option key={t} value={t}>{ISSUE_TYPES[t]}</option>)}</select></div>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />무효 포함</label>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>시각</th><th>투표소 · 창구</th><th>유형</th><th>묶음 · 번호</th><th className="num">장수</th><th>메모</th><th>담당자</th><th></th></tr></thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id} style={i.voided_at ? { opacity: 0.5 } : undefined}>
                  <td>{fmtTime(i.at)}</td>
                  <td>{sname(i.station_id)} · {i.desk_name ?? '-'}</td>
                  <td>{ISSUE_TYPES[i.type]}</td>
                  <td className="mono">{[i.pad_label, serial(i)].filter(Boolean).join(' · ') || '-'}</td>
                  <td className="num">{i.count}</td>
                  <td className="small">{i.note}{i.voided_at && <div className="muted">무효: {i.void_reason}</div>}</td>
                  <td className="small muted">{i.operator_name}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {i.voided_at ? <span className="pill">무효</span> : (
                      <>
                        {i.reviewed_at ? <span className="pill good" title={i.reviewed_by ?? ''}>확인</span>
                          : <button className="btn sm" onClick={() => run(() => api(`/roster/issues/${i.id}/review`, { body: {} }))}>확인</button>}
                        {' '}<button className="btn sm ghost" onClick={() => voidIssue(i)}>무효</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={8} className="muted center">신고된 이슈가 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h2>묶음 현황</h2>
        <p className="muted small">등록된 묶음 {padRows.length}개 / 전체 {totalPads}개 ({fmtNo(1)}~{fmtNo(pads.data?.serial_max ?? 0)}) · 다 쓴 묶음 {padRows.filter((p) => p.exhausted_at).length}개 · 이동 {pads.data?.moves.length ?? 0}건</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>번호대</th><th>투표소 · 창구</th><th className="num">사용</th><th>직전 마감 번호</th><th>등록</th><th></th></tr></thead>
            <tbody>
              {padRows.map((p) => (
                <tr key={p.id}>
                  <td className="mono" style={{ fontWeight: 600 }}>{fmtNo(p.first_no)}~{fmtNo(p.last_no)}</td>
                  <td>{sname(p.station_id)} · {dname(p.desk_id)}</td>
                  <td className="num">{p.used_total}{p.exhausted_at ? <span className="small muted"> (다 씀)</span> : null}</td>
                  <td className="mono">{p.used_total === 0 ? '-' : p.by_count || p.used_no === null ? `${p.used_total}장 (장수 입력)` : fmtNo(p.used_no)}</td>
                  <td className="small muted">{fmtTime(p.opened_at)} · {p.opened_by}{(pads.data?.moves ?? []).filter((m) => m.pad_id === p.id).map((m) => <div key={m.id}>{fmtTime(m.at)} {dname(m.from_desk_id)} → {dname(m.to_desk_id)} ({m.operator_name})</div>)}</td>
                  <td><button className="btn sm ghost" onClick={() => { setPadEdit(p); setPadForm({ used_total: String(p.used_total), desk_id: p.desk_id, reason: '' }); }}>정정</button></td>
                </tr>
              ))}
              {padRows.length === 0 && <tr><td colSpan={6} className="muted center">등록된 묶음이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h2>창구 관리</h2>
        <p className="muted small">창구는 근무자가 담당자를 등록할 때 직접 만들 수 있습니다. 목록이 정해졌으면 여기서 미리 만들어 두세요. 한 학과는 한 투표소에서 창구 한 곳에만 속합니다.</p>
        <div className="field"><label htmlFor="dk-st">투표소</label>
          <select id="dk-st" className="input" value={deskStation} onChange={(e) => loadDesks(e.target.value)}><option value="">투표소 선택</option>{config.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        {deskList && (
          <>
            <div className="list">
              {deskList.desks.map((d) => (
                <div key={d.id} className="list-item">
                  <div><div className="title">{d.name}</div><div className="sub">{d.is_unassigned ? '장애 시트·총관리자 체크용' : d.is_all ? '학과 구분 없음' : d.depts.map(deptLabel).join(', ')} · 기기 {d.device_count}대</div></div>
                  <div className="right row" style={{ gap: 6 }}>
                    {!d.is_unassigned && <button className="btn sm ghost" onClick={() => { const name = window.prompt('창구 이름', d.name); if (name?.trim() && name.trim() !== d.name) deskAction(() => api(`/desks/${d.id}`, { method: 'PUT', body: { name } }), '창구 이름을 바꿨습니다.'); }}>이름</button>}
                    {deskList.desks.length > 1 && (
                      <select className="input" style={{ width: 150 }} value="" onChange={(e) => { const to = deskList.desks.find((x) => x.id === e.target.value); if (to && window.confirm(`"${d.name}" 창구를 "${to.name}" 창구로 합칠까요? 묶음과 기기가 옮겨지고 되돌릴 수 없습니다.`)) deskAction(() => api(`/desks/${d.id}/merge`, { body: { into_id: to.id } }), '창구를 합쳤습니다.'); }}>
                        <option value="">다른 창구로 합치기</option>
                        {deskList.desks.filter((x) => x.id !== d.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    )}
                  </div>
                </div>
              ))}
              {deskList.desks.length === 0 && <p className="muted small">아직 창구가 없습니다.</p>}
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <strong>새 창구</strong>
              <div className="chips">
                {deskList.depts.filter((d) => !d.desk_id).map((d) => (
                  <button key={d.name} className={`chip ${newDepts.includes(d.name) ? 'active' : ''}`} onClick={() => setNewDepts(newDepts.includes(d.name) ? newDepts.filter((x) => x !== d.name) : [...newDepts, d.name])}>{deptLabel(d.name) || '(학과 미기재)'}</button>
                ))}
                {deskList.depts.every((d) => d.desk_id) && <span className="muted small">모든 학과에 창구가 있습니다.</span>}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm primary" disabled={!newDepts.length} onClick={() => deskAction(() => api('/desks', { body: { station_id: deskStation, depts: newDepts } }), '창구를 만들었습니다.')}>고른 학과로 창구 만들기</button>
                {!deskList.desks.some((d) => d.is_all) && <button className="btn sm" onClick={() => deskAction(() => api('/desks', { body: { station_id: deskStation, all: true } }), '"전체" 창구를 만들었습니다.')}>"전체" 창구 만들기</button>}
              </div>
            </div>
          </>
        )}
      </div>

      <Sheet open={!!padEdit} onClose={() => setPadEdit(null)} title="묶음 정정 (총관리자)">
        {padEdit && (
          <div className="stack">
            <p className="muted small">번호 건너뜀·잘못 입력한 마감 번호 등을 바로잡을 때만 씁니다. 변경 로그에 남습니다.</p>
            <div className="row between"><strong className="mono">{fmtNo(padEdit.first_no)}~{fmtNo(padEdit.last_no)}</strong><span className="muted">{sname(padEdit.station_id)} · {dname(padEdit.desk_id)}</span></div>
            <div className="field"><label>누적 사용 장수 (직전 마감 기준)</label><input className="input" inputMode="numeric" value={padForm.used_total} onChange={(e) => setPadForm({ ...padForm, used_total: e.target.value.replace(/[^0-9]/g, '') })} /></div>
            <div className="field"><label>창구</label>
              <select className="input" value={padForm.desk_id} onChange={(e) => setPadForm({ ...padForm, desk_id: e.target.value })}>
                {desks.filter((d) => !d.merged_into).map((d) => <option key={d.id} value={d.id}>{sname(d.station_id)} · {d.name}</option>)}
              </select></div>
            <div className="field"><label>사유</label><input className="input" value={padForm.reason} onChange={(e) => setPadForm({ ...padForm, reason: e.target.value })} placeholder="예: 마감 번호 오입력 정정" /></div>
            <button className="btn primary block" disabled={!padForm.reason.trim()} onClick={savePad}>정정 저장</button>
          </div>
        )}
      </Sheet>
    </main>
  );
}
