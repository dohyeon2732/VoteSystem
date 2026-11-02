import { useMemo, useState } from 'react';
import { api, fmtTime, type AuditLog } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';

const ACTION_KO: Record<string, string> = {
  'entry.create': '입력', 'entry.overwrite': '덮어쓰기', 'entry.admin_edit': '관리자 직접 수정', 'entry.confirm': '확정', 'entry.unconfirm': '확정 해제',
  'slot.confirm_all': '시점 일괄 확정', 'slot.unconfirm_all': '시점 일괄 해제', 'request.create': '수정요청', 'request.approve': '승인', 'request.reject': '거절',
  'election.update': '선거 설정 변경', 'voters.update': '유권자수 변경', 'station.update': '투표소 변경', 'slot.add': '시점 추가', 'slot.remove': '시점 삭제',
  'member.create': '위원 등록', 'member.regenerate': '코드 재발급', 'member.update': '위원 변경', 'system.reset': '전체 초기화',
};

function describe(j: string | null): string {
  if (!j) return '';
  try {
    const o = JSON.parse(j);
    if (typeof o.cumulative === 'number') return `${o.cumulative}명 (휴학 ${o.leave_cumulative ?? 0})${o.by ? ' · ' + o.by : ''}`;
    if (typeof o.base_voters === 'number') return `${o.name} ${o.base_voters}명`;
    if (o.name && o.role) return `${o.name} (${o.role === 'admin' ? '총관리자' : '선관위원'}${o.active === false ? ', 비활성' : ''})`;
    return Object.entries(o).filter(([k]) => k !== 'id').map(([k, v]) => `${k}=${v}`).join(', ');
  } catch { return j; }
}

export default function Log() {
  const { config } = useStore();
  const { data } = usePolling(() => api<{ log: AuditLog[] }>('/log?limit=1000'), 15000, []);
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const all = data?.log ?? [];
    const s = q.trim();
    if (!s) return all;
    return all.filter((l) => [l.actor_name, ACTION_KO[l.action] ?? l.action, l.note ?? '', config?.stations.find((x) => x.id === l.station_id)?.name ?? ''].some((v) => v.includes(s)));
  }, [data, q, config]);
  const where = (l: AuditLog) => {
    const st = config?.stations.find((s) => s.id === l.station_id);
    const slot = config?.slots.find((s) => s.id === l.slot_id);
    const day = config?.days.find((d) => d.id === slot?.day_id);
    return [st?.name, day ? `${day.date.slice(5).replace('-', '/')} ${slot?.time}` : null].filter(Boolean).join(' · ');
  };
  return (
    <main className="stack">
      <div className="card stack">
        <div className="row between">
          <h1>변경 로그</h1>
          <input className="input" style={{ maxWidth: 260 }} placeholder="이름, 동작, 투표소 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>시각</th><th>누가</th><th>동작</th><th>대상</th><th>이전</th><th>이후</th><th>비고</th></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td className="small muted">{fmtTime(l.at)}</td>
                  <td style={{ fontWeight: 600 }}>{l.actor_name}</td>
                  <td>{ACTION_KO[l.action] ?? l.action}</td>
                  <td className="small">{where(l)}</td>
                  <td className="small muted">{describe(l.before_json)}</td>
                  <td className="small">{describe(l.after_json)}</td>
                  <td className="small muted">{l.note}</td>
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
