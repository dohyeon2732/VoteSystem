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
  /** 명부를 쓰는 선거에서는 대조 전 체크까지 넣은 실시간 값을 기본으로 보여 준다 (FR-118). 공식 값은 '대조 완료' */
  const [mode, setMode] = useState<'live' | 'official'>('live');
  /** 예상을 낸 기준 시각. ''이면 지금, 'HH:MM'이면 오늘 그 정각 기준으로 되짚는다 (FR-128) */
  const [fcBase, setFcBase] = useState('');
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
  const roster = tally.roster?.roster_active ? tally.roster : null;
  const live = !!roster && mode === 'live';
  const pctOf = (c: number, v: number) => (v > 0 ? Math.round((c / v) * 10000) / 100 : 0);
  // 실시간: 투표소별 체크 인원(대조 전 포함)으로 선거구·전체 값을 다시 만든다. 유권자수 = 재학생 + 투표한 휴학생
  const liveDistricts = !roster ? current.districts : current.districts.map((d) => {
    const stations = d.stations.map((s) => {
      const r = roster.stations.find((x) => x.station_id === s.station_id);
      return { ...s, cumulative: r?.live ?? 0, leave_cumulative: r?.live_leave ?? 0 };
    });
    const cumulative = stations.reduce((a, x) => a + x.cumulative, 0);
    const leave = stations.reduce((a, x) => a + x.leave_cumulative, 0);
    const voters = d.base_voters + leave;
    return { ...d, stations, cumulative, leave_cumulative: leave, voters, pct: pctOf(cumulative, voters), delta: cumulative - d.cumulative, missing: 0 };
  });
  const sum = (f: (d: (typeof liveDistricts)[number]) => number) => liveDistricts.reduce((a, d) => a + f(d), 0);
  const liveT = { ...current.total, cumulative: sum((d) => d.cumulative), leave_cumulative: sum((d) => d.leave_cumulative), voters: sum((d) => d.voters), pct: pctOf(sum((d) => d.cumulative), sum((d) => d.voters)), delta: sum((d) => d.cumulative) - current.total.cumulative, missing: 0 };
  const t = live ? liveT : current.total;
  const districts = live ? liveDistricts : current.districts;
  const shownPrevDay = live ? null : prevDay;
  const reached = t.pct >= th && t.voters > 0;
  const remaining = remainingToThreshold(t.voters, t.cumulative, th);
  const ranked = [...districts].sort((a, b) => b.pct - a.pct || b.cumulative - a.cumulative);
  const rankOf = new Map(ranked.map((d, i) => [d.district_id, i + 1]));
  const baseVoters = current.total.base_voters;
  const series = live
    ? [
        ...(roster?.live_series ?? []).map((p) => ({ label: pointLabel(p), pct: pctOf(p.cumulative, baseVoters + p.leave_cumulative), cumulative: p.cumulative })),
        { label: '지금', pct: liveT.pct, cumulative: liveT.cumulative },
      ].filter((p, i, a) => i < a.length - 1 || a.length === 1 || p.cumulative !== a[i - 1].cumulative)
    : tally.points.map((p) => ({ label: pointLabel(p), pct: p.total.pct, cumulative: p.total.cumulative }));
  // 예상 (FR-127): 기준 값에 남은 구간의 예상 증가를 더해 점선으로 잇는다. 기준은 지금 또는 오늘의 지난 정각 (FR-128)
  const fcPast = live ? roster?.forecasts_past ?? [] : [];
  const fcBack = fcPast.find((f) => f.as_of === fcBase) ?? null;
  const fc = live ? fcBack ?? roster?.forecast ?? null : null;
  const todayPoints = (roster?.live_series ?? []).filter((p) => p.date === fc?.today);
  const basePoint = fcBack ? todayPoints.find((p) => p.time === fcBack.as_of) ?? null : null;
  // 기준 시각의 누적·유권자수·투표율
  const base = basePoint
    ? { cum: basePoint.cumulative, voters: baseVoters + basePoint.leave_cumulative, label: pointLabel(basePoint) }
    : { cum: liveT.cumulative, voters: liveT.voters, label: '' };
  const basePct = pctOf(base.cum, base.voters);
  const fcAt = (p: { add: number; leave_add: number }) => ({ cum: base.cum + p.add, pct: pctOf(base.cum + p.add, base.voters + p.leave_add) });
  type SeriesPoint = { label: string; pct?: number; cumulative: number; forecast?: number; fcCum?: number };
  const chartData: SeriesPoint[] = series.map((p) => ({ ...p }));
  if (fc?.points.length && chartData.length) {
    const start = basePoint ? chartData.find((r) => r.label === base.label) : chartData[chartData.length - 1];
    if (start) { start.forecast = basePct; start.fcCum = base.cum; }
    for (const p of fc.points) {
      const label = pointLabel({ date: fc.today, time: p.time }), v = fcAt(p);
      const row = chartData.find((r) => r.label === label);
      // 이미 지난 시각이면 실제 값이 있는 점에 예상을 겹쳐 놓는다
      if (row) { row.forecast = v.pct; row.fcCum = v.cum; } else chartData.push({ label, cumulative: v.cum, forecast: v.pct, fcCum: v.cum });
    }
  }
  // 되짚을 때는 오늘만 크게 보여 준다 (전날 마지막 점부터)
  const firstToday = fc ? chartData.findIndex((r) => r.label.startsWith(shortDate(fc.today))) : -1;
  const shownData = fcBack && firstToday >= 0 ? chartData.slice(Math.max(0, firstToday - 1)) : chartData;
  const shownVals = shownData.flatMap((r) => [r.pct, r.forecast]).filter((v): v is number => v != null);
  const yDomain: [number, number] = fcBack && shownVals.length
    ? [Math.max(0, Math.floor((Math.min(...shownVals) - 1) / 5) * 5), Math.min(100, Math.ceil((Math.max(...shownVals, th) + 1) / 5) * 5)]
    : [0, 100];
  const fcEnd = fc?.points.at(-1) ?? null;
  const fcEndCum = fcEnd ? base.cum + fcEnd.add : 0, fcEndVoters = fcEnd ? base.voters + fcEnd.leave_add : 0;
  const fcStartPct = fc ? pctOf(base.cum - fc.today_gain, base.voters - fc.today_leave_gain) : 0;
  // 되짚기: 실제 값이 있는 가장 늦은 정각에서 예상과 실제를 비교한다
  const checkPoint = fcBack ? todayPoints.filter((p) => p.time > fcBack.as_of!).at(-1) ?? null : null;
  const checkFc = checkPoint ? fcBack?.points.find((p) => p.time === checkPoint.time) ?? null : null;
  const nowEnd = roster?.forecast?.points.at(-1) ?? null;
  const signed = (n: number) => `${n >= 0 ? '+' : '−'}${fmtNum(Math.abs(n))}`;
  const spring = { type: 'spring', bounce: 0, duration: 0.5 } as const;
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
            <p className="muted small">10초마다 자동 갱신 · {live ? '실시간 (대조 전 체크 포함)' : `${pointLabel(current)} 기준`}</p>
          </div>
          <div className="row">
            {me?.role === 'admin' && tally.pending_requests > 0 && (
              <Link to="/admin/confirm" className="pill danger">승인 대기 {tally.pending_requests}건</Link>
            )}
            {roster && (
              <div className="chips">
                <button className={`chip ${live ? 'active' : ''}`} aria-pressed={live} onClick={() => setMode('live')}>실시간</button>
                <button className={`chip ${!live ? 'active' : ''}`} aria-pressed={!live} onClick={() => setMode('official')}>대조 완료 (공식)</button>
              </div>
            )}
            {t.missing > 0 && <span className="pill warn">{t.missing}개 투표소 {missLabel}</span>}
            {isFinal && !live && <span className="pill accent">최종 시점</span>}
          </div>
        </div>
        {!live && <PointPicker config={config} value={point} onChange={setPoint} following={following} isLive={isLive} onResetToLive={resetToLive} />}
      </div>

      {roster && (
        <div className="card stack">
          <div className="row between">
            <h2>선거인명부 체크</h2>
            <span className="small muted">{live ? '아래 투표율은 대조 전 체크까지 넣은 실시간 값입니다. 공지는 대조를 마친 값만 씁니다' : '공지·투표율은 꼬리표 대조를 마친 값만 씁니다'}</span>
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
            <h2>{live ? '전체 투표율 (실시간)' : isFinal ? '최종 결과' : '전체 투표율'}</h2>
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
            <span className="small muted">{live ? `대조 완료 값보다 +${fmtNum(t.delta)}명` : `이번 시점 증가 ${fmtNum(t.delta)}명`}</span>
            <span style={{ fontWeight: 600 }}>{reached ? '개표 기준 달성' : `개표 가능까지 ${fmtNum(remaining)}명`}</span>
          </div>
          {t.voters === 0 && <div className="alert warn">유권자수가 아직 입력되지 않았습니다. 설정에서 선거구별 기본 유권자수를 입력하세요.</div>}
          {shownPrevDay && <div className="small muted">전일 같은 시각({shortDate(shownPrevDay.date)} {shownPrevDay.time}) 전체 {fmtPct(shownPrevDay.total.pct)} · {t.pct - shownPrevDay.total.pct >= 0 ? '+' : ''}{(t.pct - shownPrevDay.total.pct).toFixed(2)}%p</div>}
        </div>

        <div className="card">
          <div className="row between" style={{ marginBottom: 8 }}>
            <h2>{live ? '시간별 전체 투표율 추이 (실시간)' : '시점별 전체 투표율 추이'}</h2>
            {live && fcPast.length > 0 && (
              <label className="small muted row" style={{ gap: 6 }}>예상 기준
                <select className="input" style={{ width: 'auto', padding: '4px 8px' }} value={fcBack ? fcBase : ''} onChange={(e) => setFcBase(e.target.value)}>
                  <option value="">지금</option>
                  {fcPast.map((f) => <option key={f.as_of} value={f.as_of ?? ''}>{f.as_of}</option>)}
                </select>
              </label>
            )}
          </div>
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={shownData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} interval="preserveStartEnd" minTickGap={24} />
                <YAxis domain={yDomain} allowDataOverflow tick={{ fontSize: 11, fill: 'var(--muted)' }} unit="%" />
                <Tooltip formatter={(v: number, _n: string, item: { dataKey?: string | number; payload?: { cumulative?: number; fcCum?: number } }) => item.dataKey === 'forecast' ? [`${fmtPct(v)} (${fmtNum(item.payload?.fcCum ?? 0)}명)`, '예상 투표율'] : [`${fmtPct(v)} (${fmtNum(item.payload?.cumulative ?? 0)}명)`, '전체 투표율']} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)' }} />
                <ReferenceLine y={th} stroke="var(--danger)" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="pct" stroke="var(--accent)" strokeWidth={2.5} dot={{ r: 2 }} isAnimationActive={!reduce} />
                {fc && fc.points.length > 0 && <Line type="monotone" dataKey="forecast" stroke="var(--warn)" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 2 }} connectNulls isAnimationActive={false} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {fc && (
            <div className="small" style={{ marginTop: 8, display: 'grid', gap: 4 }}>
              <div><b>오늘 {fcBack ? `${fcBack.as_of}까지` : '지금까지'} {signed(fc.today_gain)}명</b> ({(basePct - fcStartPct >= 0 ? '+' : '') + (basePct - fcStartPct).toFixed(2)}%p)</div>
              <div className="muted">
                같은 시각까지: {fc.past.map((p) => `${shortDate(p.date)} ${signed(p.gain)}명`).join(' · ')}
                {fc.past.length > 1 && ` · 평균 ${signed(fc.avg_gain)}명`}
              </div>
              {checkPoint && checkFc && (
                <div>
                  <b>{checkPoint.time} 예상 {fmtNum(fcAt(checkFc).cum)}명 · 실제 {fmtNum(checkPoint.cumulative)}명</b> (실제가 {signed(checkPoint.cumulative - fcAt(checkFc).cum)}명)
                </div>
              )}
              {fcEnd && (
                <div>
                  <b>예상 마감({fcEnd.time}) {fmtPct(pctOf(fcEndCum, fcEndVoters))}</b> · 누적 {fmtNum(fcEndCum)}명 ({fcBack ? `${fcBack.as_of}부터` : '지금부터'} {signed(fcEnd.add)}명)
                  {' · '}{pctOf(fcEndCum, fcEndVoters) >= th ? `기준 ${th}% 넘김` : `기준 ${th}%까지 ${fmtNum(remainingToThreshold(fcEndVoters, fcEndCum, th))}명 부족`}
                  {fcBack && nowEnd && <span className="muted"> · 지금 기준 예상 {fmtPct(pctOf(liveT.cumulative + nowEnd.add, liveT.voters + nowEnd.leave_add))}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 8 }}>선거구별 투표율</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>순위</th><th>선거구</th><th className="num">유권자수</th><th className="num">누적 투표자</th><th className="num">투표율</th>
                <th className="num">{live ? '대조 대기' : '증가분'}</th>{shownPrevDay && <th className="num">전일 동시각</th>}{!live && <th>최종 입력</th>}{!live && <th>상태</th>}
              </tr>
            </thead>
            <tbody>
              {ranked.map((d) => {
                const pd = shownPrevDay?.districts.find((x) => x.district_id === d.district_id);
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
                      {shownPrevDay && <td className="num muted">{pd ? fmtPct(pd.pct) : '-'}</td>}
                      {!live && <td className="small muted">{d.last_entry_by ?? '-'}{d.last_entry_at ? ` · ${fmtTime(d.last_entry_at)}` : ''}</td>}
                      {!live && <td>{d.missing > 0 ? <span className="pill danger">{missLabel} {multi ? d.missing + '곳' : ''}</span> : d.stations.some((s) => s.has_slot) ? (d.stations.filter((s) => s.has_slot).every((s) => s.confirmed) ? <span className="pill good">확정</span> : <span className="pill muted">확정 전</span>) : <span className="pill muted">이어씀</span>}</td>}
                    </tr>
                    {multi && open && d.stations.map((s) => {
                      const st = config.stations.find((x) => x.id === s.station_id);
                      return (
                        <tr className="sub" key={s.station_id}>
                          <td></td><td>└ {st?.name}</td><td className="num muted">-</td><td className="num">{fmtNum(s.cumulative)}</td><td className="num muted">-</td><td className="num muted">-</td>{shownPrevDay && <td></td>}
                          {!live && <td className="small muted">{s.last_entry_by ?? '-'}{s.last_entry_at ? ` · ${fmtTime(s.last_entry_at)}` : ''}</td>}
                          {!live && <td>{!s.has_slot ? <span className="pill muted">시점 없음</span> : s.entered ? (s.confirmed ? <span className="pill good">확정</span> : <span className="pill muted">확정 전</span>) : <span className="pill danger">{missLabel}</span>}</td>}
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
            <BarChart data={districts.map((d) => ({ name: d.name.replace('대학', ''), pct: d.pct }))} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
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
