import { useState } from 'react';
import { api, deptLabel, fmtNo, fmtTime, ISSUE_TYPES, type DeskList, type IssueType, type TagIssueRow } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import { downloadText, toCsv } from '../data/sheet';

/** S-15 꼬리표 이슈·창구 관리 (FR-105, FR-107) */
export default function AdminIssues() {
  const { config } = useStore();
  const issues = usePolling(() => api<{ issues: TagIssueRow[] }>('/roster/issues'), 20000, []);
  const [fStation, setFStation] = useState('');
  const [fType, setFType] = useState('');
  const [showVoided, setShowVoided] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deskStation, setDeskStation] = useState('');
  const [deskList, setDeskList] = useState<DeskList | null>(null);
  const [newDepts, setNewDepts] = useState<string[]>([]);
  const [deskMsg, setDeskMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** 학과 구성을 고치는 중인 창구 (FR-107) */
  const [deskEdit, setDeskEdit] = useState<{ id: string; depts: string[] } | null>(null);

  if (!config) return <main><p className="muted center">불러오는 중…</p></main>;
  const sname = (id: string) => config.stations.find((s) => s.id === id)?.name ?? '?';
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setMsg(null);
    try { await fn(); await issues.reload(); if (done) setMsg({ ok: true, text: done }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const serial = (i: TagIssueRow) => (i.serial_from === null ? '' : i.serial_to !== null && i.serial_to !== i.serial_from ? `${fmtNo(i.serial_from)}~${fmtNo(i.serial_to)}` : fmtNo(i.serial_from));
  const all = issues.data?.issues ?? [];
  const list = all.filter((i) => (!fStation || i.station_id === fStation) && (!fType || i.type === fType) && (showVoided || !i.voided_at));
  const live = all.filter((i) => !i.voided_at);
  const exportCsv = () => downloadText('꼬리표_이슈.csv', toCsv([
    ['시각', '투표소', '창구', '유형', '용지 번호', '장수', '메모', '담당자', '확인', '확인자', '무효', '무효 사유'],
    ...all.map((i) => [fmtTime(i.at), sname(i.station_id), i.desk_name ?? '', ISSUE_TYPES[i.type], serial(i), i.count, i.note ?? '', i.operator_name,
      i.reviewed_at ? '확인' : '미확인', i.reviewed_by ?? '', i.voided_at ? '무효' : '', i.void_reason ?? '']),
  ]));
  const voidIssue = (i: TagIssueRow) => {
    const reason = window.prompt('무효로 처리하는 사유를 적어 주세요.');
    if (reason?.trim()) run(() => api(`/roster/issues/${i.id}/void`, { body: { reason } }));
  };

  const loadDesks = async (stationId: string) => {
    setDeskStation(stationId); setDeskList(null); setNewDepts([]); setDeskEdit(null);
    if (stationId) try { setDeskList(await api<DeskList>(`/roster/desks?station_id=${encodeURIComponent(stationId)}`)); } catch (e) { setDeskMsg({ ok: false, text: (e as Error).message }); }
  };
  // 결과는 창구 관리 칸 안에 보여 준다 (페이지 맨 위 알림은 스크롤하면 안 보인다)
  const deskAction = async (fn: () => Promise<unknown>, done: string) => {
    setDeskMsg(null);
    try { await fn(); await loadDesks(deskStation); setDeskMsg({ ok: true, text: done }); }
    catch (e) { setDeskMsg({ ok: false, text: (e as Error).message }); }
  };
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

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
            <thead><tr><th>시각</th><th>투표소 · 창구</th><th>유형</th><th>용지 번호</th><th className="num">장수</th><th>메모</th><th>담당자</th><th></th></tr></thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id} style={i.voided_at ? { opacity: 0.5 } : undefined}>
                  <td>{fmtTime(i.at)}</td>
                  <td>{sname(i.station_id)} · {i.desk_name ?? '-'}</td>
                  <td>{ISSUE_TYPES[i.type]}</td>
                  <td className="mono">{serial(i) || '-'}</td>
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
        <h2>창구 관리</h2>
        <p className="muted small">창구는 근무자가 담당자를 등록할 때 직접 만들 수 있습니다. 목록이 정해졌으면 여기서 미리 만들어 두세요. 한 학과는 한 투표소에서 창구 한 곳에만 속합니다.</p>
        <div className="field"><label htmlFor="dk-st">투표소</label>
          <select id="dk-st" className="input" value={deskStation} onChange={(e) => loadDesks(e.target.value)}><option value="">투표소 선택</option>{config.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        {deskMsg && <div className={`alert ${deskMsg.ok ? 'good' : 'danger'}`} role="alert">{deskMsg.text}</div>}
        {deskStation && !deskList && !deskMsg && <p className="muted small">창구 목록을 불러오는 중…</p>}
        {deskList && (
          <>
            <div className="list">
              {deskList.desks.map((d) => (
                <div key={d.id}>
                <div className="list-item">
                  <div><div className="title">{d.name}</div><div className="sub">{d.is_unassigned ? '장애 시트·총관리자 체크용' : d.is_all ? '학과 구분 없음' : d.depts.map(deptLabel).join(', ')} · 기기 {d.device_count}대</div></div>
                  <div className="right row" style={{ gap: 6 }}>
                    {!d.is_unassigned && <button className="btn sm ghost" onClick={() => { const name = window.prompt('창구 이름', d.name); if (name?.trim() && name.trim() !== d.name) deskAction(() => api(`/desks/${d.id}`, { method: 'PUT', body: { name } }), '창구 이름을 바꿨습니다.'); }}>이름</button>}
                    {!d.is_unassigned && !d.is_all && <button className="btn sm ghost" onClick={() => setDeskEdit(deskEdit?.id === d.id ? null : { id: d.id, depts: d.depts })}>학과</button>}
                    {deskList.desks.length > 1 && (
                      <select className="input" style={{ width: 150 }} value="" onChange={(e) => { const to = deskList.desks.find((x) => x.id === e.target.value); if (to && window.confirm(`"${d.name}" 창구를 "${to.name}" 창구로 합칠까요? 기기가 옮겨지고 되돌릴 수 없습니다. 두 창구의 꼬리표는 합친 창구에서 함께 셉니다.`)) deskAction(() => api(`/desks/${d.id}/merge`, { body: { into_id: to.id } }), '창구를 합쳤습니다.'); }}>
                        <option value="">다른 창구로 합치기</option>
                        {deskList.desks.filter((x) => x.id !== d.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    )}
                  </div>
                </div>
                {deskEdit?.id === d.id && (
                  <div className="stack" style={{ gap: 6, padding: '4px 0 12px' }}>
                    <span className="muted small">이 창구가 맡을 학과를 고르세요. 다른 창구가 맡은 학과는 나오지 않습니다.</span>
                    <div className="chips">
                      {[...new Set([...d.depts, ...deskList.depts.filter((x) => !x.desk_id).map((x) => x.name)])].map((name) => (
                        <button key={name} type="button" aria-pressed={deskEdit.depts.includes(name)} className={`chip ${deskEdit.depts.includes(name) ? 'active' : ''}`} onClick={() => setDeskEdit({ id: d.id, depts: toggle(deskEdit.depts, name) })}>{deptLabel(name) || '(학과 미기재)'}</button>
                      ))}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm primary" disabled={!deskEdit.depts.length} onClick={() => deskAction(() => api(`/desks/${d.id}`, { method: 'PUT', body: { depts: deskEdit.depts } }), '창구의 학과를 바꿨습니다.')}>저장</button>
                      <button className="btn sm ghost" onClick={() => setDeskEdit(null)}>닫기</button>
                    </div>
                  </div>
                )}
                </div>
              ))}
              {deskList.desks.length === 0 && <p className="muted small">아직 창구가 없습니다.</p>}
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <strong>새 창구</strong>
              <div className="chips">
                {deskList.depts.filter((d) => !d.desk_id).map((d) => (
                  <button key={d.name} className={`chip ${newDepts.includes(d.name) ? 'active' : ''}`} onClick={() => setNewDepts(toggle(newDepts, d.name))}>{deptLabel(d.name) || '(학과 미기재)'}</button>
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

    </main>
  );
}
