import { useEffect, useState } from 'react';
import { api, fmtNum, shortDate, type Election, type Station } from '../apis';
import { useStore } from '../app/store';

function Toggle({ label, hint, checked, onChange, danger }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; danger?: boolean }) {
  return (
    <label className="switch row between" style={{ width: '100%' }}>
      <span><div style={{ fontWeight: 600, color: danger && checked ? 'var(--danger)' : undefined }}>{label}</div>{hint && <div className="small muted">{hint}</div>}</span>
      <span className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="track" />
      </span>
    </label>
  );
}

export default function AdminSettings() {
  const { config, refreshConfig } = useStore();
  const [msg, setMsg] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [threshold, setThreshold] = useState('50');
  const [voters, setVoters] = useState<Record<string, string>>({});
  const [times, setTimes] = useState<Record<string, { open: string; close: string }>>({});
  const [newTime, setNewTime] = useState('');
  const [resetText, setResetText] = useState('');

  useEffect(() => {
    if (!config) return;
    setName(config.election.name); setThreshold(String(config.election.threshold_pct));
    setVoters(Object.fromEntries(config.districts.map((d) => [d.id, String(d.base_voters)])));
    setTimes(Object.fromEntries(config.stations.map((s) => [s.id, { open: s.open_time, close: s.close_time }])));
  }, [config]);

  if (!config) return <main><p className="muted center">불러오는 중…</p></main>;
  const el = config.election;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); await refreshConfig(); setMsg(ok); } catch (e) { setMsg((e as Error).message); }
  };
  const tallyTimes = [...new Set(config.slots.filter((x) => !x.is_close).map((x) => x.time))].sort();
  const closeTimes = [...new Set(config.stations.map((x) => x.close_time))].sort();
  const applyTimes = (next: string[], ok: string) => run(() => api('/tally-times', { method: 'PUT', body: { times: next } }), ok);
  const patchElection = (patch: Partial<Election>, ok = '저장했습니다.') => run(() => api('/election', { method: 'PUT', body: patch }), ok);

  return (
    <main className="stack">
      {msg && <div className="alert info">{msg}</div>}
      <div className="grid cols-2">
        <div className="card stack">
          <h1>선거 설정</h1>
          <div className="field"><label>선거 명칭</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>개표 가능 기준 투표율 (%)</label><input className="input" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
          <button className="btn primary" onClick={() => patchElection({ name, threshold_pct: Number(threshold) })}>저장</button>
        </div>
        <div className="card stack">
          <h1>운영 스위치</h1>
          <Toggle label="연장투표 활성화" hint={`${config.days.filter((d) => d.is_extension).map((d) => shortDate(d.date)).join(', ')} 시점이 전체 투표소에 추가됩니다`} checked={el.extension_enabled} onChange={(v) => patchElection({ extension_enabled: v }, v ? '연장투표를 활성화했습니다.' : '연장투표를 해제했습니다.')} />
          <Toggle label="입력 잠금" hint="잠그면 선관위원은 입력할 수 없고 총관리자만 입력할 수 있습니다" checked={el.input_locked} onChange={(v) => patchElection({ input_locked: v }, v ? '입력을 잠갔습니다.' : '입력 잠금을 해제했습니다.')} danger />
          <Toggle label="시점 시간 제한 적용" hint="켜면 집계 시각 10분 전부터만 입력 가능. 리허설 때는 끄세요" checked={el.enforce_time_window} onChange={(v) => patchElection({ enforce_time_window: v })} />
        </div>
      </div>

      <div className="card stack">
        <h1>선거구 기본 유권자수</h1>
        <p className="muted small">휴학생 제외 재학생 유권자 수. 선거 중 수정하면 모든 시점의 투표율이 즉시 재계산됩니다.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>선거구</th><th className="num">현재</th><th>새 값</th><th style={{ width: '1%' }}></th></tr></thead>
            <tbody>
              {config.districts.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 600 }}>{d.name}</td>
                  <td className="num">{fmtNum(d.base_voters)}</td>
                  <td><input className="input" style={{ width: 140 }} inputMode="numeric" value={voters[d.id] ?? ''} onChange={(e) => setVoters({ ...voters, [d.id]: e.target.value.replace(/[^0-9]/g, '') })} /></td>
                  <td><button className="btn sm" disabled={String(d.base_voters) === (voters[d.id] ?? '')} onClick={() => run(() => api(`/districts/${d.id}`, { method: 'PUT', body: { base_voters: Number(voters[d.id] || 0) } }), `${d.name} 유권자수를 저장했습니다.`)}>저장</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row between"><span className="muted">합계</span><strong>{fmtNum(config.districts.reduce((a, d) => a + d.base_voters, 0))}명</strong></div>
      </div>

      <div className="card stack">
        <h1>집계 시각</h1>
        <p className="muted small">모든 투표소·모든 날짜에 공통으로 적용됩니다. 각 투표소는 운영시간 안에 드는 집계 시각과 자기 마감 시각({closeTimes.join(', ')})을 시점으로 가집니다. 바꾸면 즉시 다시 만들어집니다. 없어질 시점에 입력값이 있으면 바뀌지 않으니, 리허설 데이터는 먼저 초기화하세요.</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {tallyTimes.length === 0 && <span className="muted small">공통 집계 시각이 없습니다. 마감 시각에만 집계합니다.</span>}
          {tallyTimes.map((t) => (
            <span key={t} className="pill" style={{ gap: 4 }}>
              {t}
              <button className="btn sm ghost" style={{ minHeight: 20, padding: '0 4px' }} aria-label={`${t} 집계 시각 삭제`} title="이 집계 시각을 삭제"
                onClick={() => { if (confirm(`${t} 집계 시각을 모든 투표소·날짜에서 삭제할까요?`)) applyTimes(tallyTimes.filter((x) => x !== t), `${t} 집계 시각을 삭제했습니다.`); }}>×</button>
            </span>
          ))}
        </div>
        <div className="form-row">
          <div className="field" style={{ flex: '0 0 auto' }}><label>집계 시각 추가</label><input className="input" type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} /></div>
          <button className="btn" disabled={!newTime || tallyTimes.includes(newTime)} onClick={() => { const t = newTime; setNewTime(''); applyTimes([...tallyTimes, t], `${t} 집계 시각을 추가했습니다.`); }}>추가</button>
        </div>

        <h2 style={{ marginTop: 8 }}>투표소 운영시간</h2>
        <p className="muted small">운영시간을 바꾸면 그 투표소의 시점이 위 집계 시각 기준으로 다시 만들어집니다.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>투표소</th><th>시작</th><th>종료</th><th></th><th>시점</th></tr></thead>
            <tbody>
              {config.stations.map((s: Station) => {
                const t = times[s.id] ?? { open: s.open_time, close: s.close_time };
                const daySlots = config.slots.filter((x) => x.station_id === s.id && x.day_id === config.days[0].id).sort((a, b) => a.time.localeCompare(b.time));
                return (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>{s.name}</td>
                    <td><input className="input" type="time" value={t.open} onChange={(e) => setTimes({ ...times, [s.id]: { ...t, open: e.target.value } })} /></td>
                    <td><input className="input" type="time" value={t.close} onChange={(e) => setTimes({ ...times, [s.id]: { ...t, close: e.target.value } })} /></td>
                    <td><button className="btn sm" disabled={t.open === s.open_time && t.close === s.close_time} onClick={() => run(() => api(`/stations/${s.id}`, { method: 'PUT', body: { open_time: t.open, close_time: t.close } }), `${s.name} 시간을 저장하고 시점을 다시 만들었습니다.`)}>저장</button></td>
                    <td className="small">
                      {daySlots.map((x) => (
                        <span key={x.id} className="pill muted" style={{ marginRight: 4 }}>{x.time}{x.is_close ? ' 마감' : ''}</span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h1>목업 데이터 넣기 (테스트 모드)</h1>
        <p className="muted small">리허설·화면 확인용. 유권자수가 비어 있는 선거구에는 예시 유권자수를 넣고, 첫 투표일의 앞 시점 4개에 임의 누적 투표자수를 채웁니다. 이미 입력된 칸은 건드리지 않으며, 입력자 이름에 "(목업)"이 붙습니다.</p>
        <button className="btn" onClick={() => run(() => api<{ created: number; votersSet: number }>('/mock', { body: {} }).then((r) => { setMsg(`목업 입력 ${r.created}건을 넣었습니다. 현황판에서 확인하세요.`); }), '목업 데이터를 넣었습니다.')}>목업 데이터 넣기</button>
      </div>

      <div className="card stack">
        <h1 style={{ color: 'var(--danger)' }}>전체 입력 초기화 (테스트 모드)</h1>
        <p className="muted small">리허설 후 모든 입력값·수정요청·변경 로그를 지웁니다. 설정, 명부, 유권자수는 유지됩니다. 되돌릴 수 없습니다.</p>
        <div className="row">
          <input className="input" style={{ maxWidth: 220 }} placeholder="초기화 라고 입력" value={resetText} onChange={(e) => setResetText(e.target.value)} />
          <button className="btn danger" disabled={resetText !== '초기화'} onClick={() => run(() => api('/reset', { body: { confirm: resetText } }).then(() => setResetText('')), '모든 입력을 초기화했습니다.')}>초기화 실행</button>
        </div>
      </div>
    </main>
  );
}
