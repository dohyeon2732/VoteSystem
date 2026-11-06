import { useState } from 'react';
import { api, fmtTime, type AccessLogRow } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';

const ACTIONS: Record<string, string> = {
  lookup: '조회', issue: '불출', cancel: '취소', close: '마감', adjust: '조정', denied: '거부', pledge: '서약', upload: '명부 업로드',
  'voter.add': '개별 추가', 'voter.edit': '개별 정정', backup: '백업', restore: '복원', 'sheet.preview': '시트 확인', 'sheet.apply': '시트 반영',
  reset_checks: '체크 초기화', purge: '파기',
};
const RESULTS: Record<string, string> = {
  ok: '정상', not_found: '명부 없음', other_district: '다른 선거구', voted: '이미 투표', already_voted: '이미 투표', rate_limited: '조회 제한',
  no_shift: '근무 외', wrong_station: '다른 투표소', begin: '시작', matched: '일치', mismatch: '불일치', adjusted: '조정', missed: '누락분',
  regular: '정회원', associate: '준회원', agreed: '동의',
};

/** S-14 접근 로그 (FR-95). 학번 원문은 남기지 않고 해시 앞 8자리만 보인다. */
export default function AccessLog() {
  const { config } = useStore();
  const [action, setAction] = useState('');
  const [member, setMember] = useState('');
  const { data } = usePolling(() => api<{ log: AccessLogRow[] }>(`/roster/access-log?limit=1000${action ? `&action=${encodeURIComponent(action)}` : ''}`), 20000, [action]);
  const rows = (data?.log ?? []).filter((r) => !member || r.member_name.includes(member));
  const sname = (id: string | null) => (id ? config?.stations.find((s) => s.id === id)?.name ?? '' : '');
  return (
    <main className="stack">
      <div className="card stack">
        <div className="row between"><h1>선거인명부 접근 로그</h1><span className="pill muted">최근 {rows.length}건</span></div>
        <p className="muted small">모든 조회·불출·취소·마감·관리 작업이 남고 지울 수 없습니다. 학번은 원문 대신 해시 앞 8자리로만 표시합니다.</p>
        <div className="form-row">
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">모든 행위</option>{Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input className="input" placeholder="위원 이름" value={member} onChange={(e) => setMember(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>시각</th><th>위원</th><th>투표소</th><th>행위</th><th>결과</th><th>학번 해시</th><th>메모</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="small">{fmtTime(r.at)}</td>
                  <td>{r.member_name}</td>
                  <td className="small">{sname(r.station_id)}</td>
                  <td>{ACTIONS[r.action] ?? r.action}</td>
                  <td>{r.result ? <span className={`pill ${['ok', 'matched', 'begin', 'agreed', 'regular', 'associate'].includes(r.result) ? 'muted' : 'warn'}`}>{RESULTS[r.result] ?? r.result}</span> : null}</td>
                  <td className="mono small">{r.sid_hash8 ?? ''}</td>
                  <td className="small muted">{r.note ?? ''}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="muted center">기록이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
