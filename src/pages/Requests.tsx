import { api, fmtNum, fmtTime, type ChangeRequest } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';

export default function Requests() {
  const { config } = useStore();
  const { data } = usePolling(() => api<{ requests: ChangeRequest[] }>('/change-requests'), 10000, []);
  const label = (r: ChangeRequest) => {
    const slot = config?.slots.find((s) => s.id === r.entry?.slot_id);
    const st = config?.stations.find((s) => s.id === r.entry?.station_id);
    const day = config?.days.find((d) => d.id === slot?.day_id);
    return `${st?.name ?? ''} · ${day?.date.slice(5).replace('-', '/') ?? ''} ${slot?.time ?? ''}`;
  };
  return (
    <main className="narrow stack">
      <div className="card">
        <h1 style={{ marginBottom: 8 }}>내 수정요청</h1>
        {!data ? <p className="muted">불러오는 중…</p> : data.requests.length === 0 ? <p className="muted">보낸 수정요청이 없습니다.</p> : (
          <div className="list">
            {data.requests.map((r) => (
              <div className="list-item" key={r.id} style={{ cursor: 'default' }}>
                <div>
                  <div className="title">{label(r)}</div>
                  <div className="sub">{fmtNum(r.entry?.cumulative ?? 0)}명 → {fmtNum(r.new_cumulative)}명 · {r.reason}</div>
                  <div className="sub">{fmtTime(r.requested_at)}{r.decided_at ? ` · ${r.decided_by_name} ${fmtTime(r.decided_at)}${r.decision_note ? ' · ' + r.decision_note : ''}` : ''}</div>
                </div>
                <div className="right">
                  {r.status === 'pending' ? <span className="pill warn">대기</span> : r.status === 'approved' ? <span className="pill good">승인</span> : <span className="pill danger">거절</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
