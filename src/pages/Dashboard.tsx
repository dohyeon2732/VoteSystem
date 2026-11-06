import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'motion/react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, fmtHM, fmtNum, fmtPct, fmtTime, pointLabel, remainingToThreshold, shortDate, type Tally, type TallyPoint } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import PointPicker, { type Point } from '../components/PointPicker';
import { useLivePoint } from '../hooks/useLivePoint';

export default function Dashboard() {
  const { config, me, refreshConfig } = useStore();
  const { data: tally, error } = usePolling(() => api<Tally>('/tally'), 10000, []);
  // 선거 시작 전에는 입력이 있는 마지막 시점, 없으면 첫 시점
  const fallback = useMemo<Point | null>(() => {
    if (!tally) return null;
    const withData = tally.points.filter((p) => p.districts.some((d) => d.stations.some((s) => s.entered)));
    const p = withData.at(-1) ?? tally.points[0];
    return p ? { date: p.date, time: p.time } : null;
  }, [tally]);
  const { point, setPoint, following, resetToLive, isLive } = useLivePoint(config, fallback);
  const [expanded, setExpanded] = useState<string | null>(null);
  const reduce = useReducedMotion();

  useEffect(() => { const t = setInterval(refreshConfig, 60000); return () => clearInterval(t); }, [refreshConfig]);


  const current: TallyPoint | null = useMemo(() => tally?.points.find((p) => p.date === point?.date && p.time === point?.time) ?? null, [tally, point]);
  const prevDay: TallyPoint | null = useMemo(() => {
    if (!tally || !current) return null;
    const dates = [...new Set(tally.points.map((p) => p.date))].sort();
    const idx = dates.indexOf(current.date);
    if (idx <= 0) return null;
    return tally.points.find((p) => p.date === dates[idx - 1] && p.time === current.time) ?? null;
  }, [tally, current]);
  const isFinal = !!tally && !!current && tally.points.at(-1)?.epoch === current.epoch;

  if (error && !tally) return <main><div className="alert danger">{error}</div></main>;
  if (!tally || !current || !config) return <main><p className="muted center">불러오는 중…</p></main>;

  const th = tally.election.threshold_pct;
  const t = current.total;
  const reached = t.pct >= th && t.voters > 0;
  const remaining = remainingToThreshold(t.voters, t.cumulative, th);
  const ranked = [...current.districts].sort((a, b) => b.pct - a.pct || b.cumulative - a.cumulative);
  const rankOf = new Map(ranked.map((d, i) => [d.district_id, i + 1]));
  const series = tally.points.map((p) => ({ label: pointLabel(p), pct: p.total.pct, cumulative: p.total.cumulative }));
  const spring = { type: 'spring', bounce: 0, duration: 0.5 } as const;
  const roster = tally.roster?.roster_active ? tally.roster : null;
  const missLabel = roster ? '대조 미완료' : '미입력';
  const liveTotal = roster ? roster.stations.reduce((a, s) => a + s.live, 0) : 0;
  const recTotal = roster ? roster.stations.reduce((a, s) => a + s.reconciled, 0) : 0;
  const warnings = roster ? roster.stations.filter((s) => s.warning || s.reconciling) : [];

  return (
    <main className="stack">
      <div className="card stack">
        <div className="row between">
          <div>
            <h1>{tally.election.name} 현황판</h1>
            <p className="muted small">10초마다 자동 갱신 · {pointLabel(current)} 기준</p>
          </div>
          <div className="row">
            {me?.role === 'admin' && tally.pending_requests > 0 && (
              <Link to="/admin/confirm" className="pill danger">승인 대기 {tally.pending_requests}건</Link>
            )}
            {t.missing > 0 && <span className="pill warn">{t.missing}개 투표소 {missLabel}</span>}
            {isFinal && <span className="pill accent">최종 시점</span>}
          </div>
        </div>
        <PointPicker config={config} value={point} onChange={setPoint} following={following} isLive={isLive} onResetToLive={resetToLive} />
      </div>

      {roster && (
        <div className="card stack">
          <div className="row between">
            <h2>선거인명부 체크</h2>
            <span className="small muted">공지·투표율은 꼬리표 대조를 마친 값만 씁니다</span>
          </div>
          <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
            <div><div className="small muted">실시간 체크 (대조 전 포함)</div><div style={{ fontSize: 28, fontWeight: 800 }}>{fmtNum(liveTotal)}명</div></div>
            <div><div className="small muted">최근 대조 완료</div><div style={{ fontSize: 28, fontWeight: 800 }}>{fmtNum(recTotal)}명</div></div>
            <div><div className="small muted">대조 대기</div><div style={{ fontSize: 28, fontWeight: 800, color: liveTotal - recTotal > 0 ? 'var(--warn)' : undefined }}>{fmtNum(liveTotal - recTotal)}명</div></div>
          </div>
          {warnings.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {warnings.map((s) => (
                <span key={s.station_id} className={`pill ${s.warning ? 'danger' : 'warn'}`}>
                  {config.stations.find((x) => x.id === s.station_id)?.name} · {s.warning ?? '대조 중'}{s.last_boundary_at ? ` (마지막 ${fmtHM(s.last_boundary_at)})` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid cols-2">
        <div className="card stack">
          <div className="row between">
            <h2>{isFinal ? '최종 결과' : '전체 투표율'}</h2>
            <span className={`pill ${reached ? 'good' : 'muted'}`}>{reached ? '개표 가능' : `개표 기준 ${th}%`}</span>
          </div>
          <motion.div key={t.pct} className="display" initial={reduce ? false : { opacity: 0.4, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
            {fmtPct(t.pct)}
          </motion.div>
          <div className="muted">{fmtNum(t.cumulative)}명 / {fmtNum(t.voters)}명 ({roster ? `재학생 ${fmtNum(t.base_voters)} + 편입 휴학생 ${fmtNum(t.leave_cumulative)}` : `기본 유권자 ${fmtNum(t.base_voters)}명 + 휴학생 투표 ${fmtNum(t.leave_cumulative)}명`})</div>
          <div style={{ paddingTop: 26 }}>
            <div className="gauge" aria-label="전체 투표율 게이지">
              <motion.div className={`fill ${reached ? 'good' : ''}`} initial={false} animate={{ width: `${Math.min(100, t.pct)}%` }} transition={spring} />
              <div className="mark" style={{ left: `${th}%` }} /><div className="mark-label" style={{ left: `${th}%` }}>{th}%</div>
            </div>
          </div>
          <div className="row between">
            <span className="small muted">이번 시점 증가 {fmtNum(t.delta)}명</span>
            <span style={{ fontWeight: 600 }}>{reached ? '개표 기준 달성' : `개표 가능까지 ${fmtNum(remaining)}명`}</span>
          </div>
          {t.voters === 0 && <div className="alert warn">유권자수가 아직 입력되지 않았습니다. 설정에서 선거구별 기본 유권자수를 입력하세요.</div>}
          {prevDay && <div className="small muted">전일 같은 시각({shortDate(prevDay.date)} {prevDay.time}) 전체 {fmtPct(prevDay.total.pct)} · {t.pct - prevDay.total.pct >= 0 ? '+' : ''}{(t.pct - prevDay.total.pct).toFixed(2)}%p</div>}
        </div>

        <div className="card">
          <h2 style={{ marginBottom: 8 }}>시점별 전체 투표율 추이</h2>
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={series} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} interval="preserveStartEnd" minTickGap={24} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--muted)' }} unit="%" />
                <Tooltip formatter={(v: number) => [fmtPct(v), '전체 투표율']} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)' }} />
                <ReferenceLine y={th} stroke="var(--danger)" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="pct" stroke="var(--accent)" strokeWidth={2.5} dot={{ r: 2 }} isAnimationActive={!reduce} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 8 }}>선거구별 투표율</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>순위</th><th>선거구</th><th className="num">유권자수</th><th className="num">누적 투표자</th><th className="num">투표율</th>
                <th className="num">증가분</th>{prevDay && <th className="num">전일 동시각</th>}<th>최종 입력</th><th>상태</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((d) => {
                const pd = prevDay?.districts.find((x) => x.district_id === d.district_id);
                const multi = d.stations.length > 1;
                const open = expanded === d.district_id;
                return (
                  <FragmentRow key={d.district_id}>
                    <tr className={multi ? 'clickable' : ''} onClick={() => multi && setExpanded(open ? null : d.district_id)}>
                      <td><span className={`rank ${rankOf.get(d.district_id)! <= 3 ? 'top' : ''}`}>{rankOf.get(d.district_id)}</span></td>
                      <td style={{ fontWeight: 600 }}>{d.name}{multi ? (open ? ' ▾' : ' ▸') : ''}</td>
                      <td className="num">{fmtNum(d.voters)}</td>
                      <td className="num">{fmtNum(d.cumulative)}</td>
                      <td className="num" style={{ fontWeight: 700, color: d.pct >= th ? 'var(--good)' : undefined }}>{fmtPct(d.pct)}</td>
                      <td className="num">{d.delta >= 0 ? '+' : ''}{fmtNum(d.delta)}</td>
                      {prevDay && <td className="num muted">{pd ? fmtPct(pd.pct) : '-'}</td>}
                      <td className="small muted">{d.last_entry_by ?? '-'}{d.last_entry_at ? ` · ${fmtTime(d.last_entry_at)}` : ''}</td>
                      <td>{d.missing > 0 ? <span className="pill danger">{missLabel} {multi ? d.missing + '곳' : ''}</span> : d.stations.some((s) => s.has_slot) ? (d.stations.filter((s) => s.has_slot).every((s) => s.confirmed) ? <span className="pill good">확정</span> : <span className="pill muted">확정 전</span>) : <span className="pill muted">이어씀</span>}</td>
                    </tr>
                    {multi && open && d.stations.map((s) => {
                      const st = config.stations.find((x) => x.id === s.station_id);
                      return (
                        <tr className="sub" key={s.station_id}>
                          <td></td><td>└ {st?.name}</td><td className="num muted">-</td><td className="num">{fmtNum(s.cumulative)}</td><td className="num muted">-</td><td className="num muted">-</td>{prevDay && <td></td>}
                          <td className="small muted">{s.last_entry_by ?? '-'}{s.last_entry_at ? ` · ${fmtTime(s.last_entry_at)}` : ''}</td>
                          <td>{!s.has_slot ? <span className="pill muted">시점 없음</span> : s.entered ? (s.confirmed ? <span className="pill good">확정</span> : <span className="pill muted">확정 전</span>) : <span className="pill danger">{missLabel}</span>}</td>
                        </tr>
                      );
                    })}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 8 }}>선거구별 투표율 그래프</h2>
        <div style={{ width: '100%', height: 300 }}>
          <ResponsiveContainer>
            <BarChart data={current.districts.map((d) => ({ name: d.name.replace('대학', ''), pct: d.pct }))} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted)' }} interval={0} angle={-30} textAnchor="end" height={60} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--muted)' }} unit="%" />
              <Tooltip formatter={(v: number) => [fmtPct(v), '투표율']} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)' }} />
              <ReferenceLine y={th} stroke="var(--danger)" strokeDasharray="4 4" />
              <Bar dataKey="pct" fill="var(--accent)" radius={[6, 6, 0, 0]} isAnimationActive={!reduce} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </main>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</>; }
