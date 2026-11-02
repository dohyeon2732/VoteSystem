import { useEffect, useMemo, useState } from 'react';
import { downloadCanvas, imageFilename, renderNoticeImages, type NoticeImages } from '../data/noticeImage';
import { api, fmtNum, fmtPct, noticeDate, remainingToThreshold, shortDate, type Tally } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import PointPicker, { type Point } from '../components/PointPicker';

export default function Notice() {
  const { config } = useStore();
  const { data: tally } = usePolling(() => api<Tally>('/tally'), 15000, []);
  const [point, setPoint] = useState<Point | null>(null);
  const [copied, setCopied] = useState(false);
  const [images, setImages] = useState<NoticeImages | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    if (!tally || point) return;
    const withData = tally.points.filter((p) => p.districts.some((d) => d.stations.some((s) => s.entered)));
    const p = withData.at(-1) ?? tally.points[0];
    if (p) setPoint({ date: p.date, time: p.time });
  }, [tally, point]);

  const current = useMemo(() => tally?.points.find((p) => p.date === point?.date && p.time === point?.time) ?? null, [tally, point]);

  useEffect(() => {
    if (!tally || !current) return;
    let cancelled = false;
    setRendering(true); setImgError(null);
    renderNoticeImages(tally.election.name, current, tally.election.threshold_pct)
      .then((r) => { if (!cancelled) setImages(r); })
      .catch((e) => { if (!cancelled) setImgError((e as Error).message); })
      .finally(() => { if (!cancelled) setRendering(false); });
    return () => { cancelled = true; };
  }, [tally, current]);

  const text = useMemo(() => {
    if (!tally || !current) return '';
    const th = tally.election.threshold_pct;
    const t = current.total;
    const remaining = remainingToThreshold(t.voters, t.cumulative, th);
    const lines = [
      `[${tally.election.name} 투표율 현황]`,
      `${shortDate(current.date)} ${current.time} 기준`,
      `전체 투표율 ${fmtPct(t.pct)} (${fmtNum(t.cumulative)}명 / ${fmtNum(t.voters)}명)`,
      t.pct >= th && t.voters > 0 ? `개표 기준 ${th}% 달성` : `개표 가능까지 ${fmtNum(remaining)}명`,
      '',
      ...current.districts.map((d) => `${d.name} ${fmtPct(d.pct)} (${fmtNum(d.cumulative)}명 / ${fmtNum(d.voters)}명)`),
    ];
    return lines.join('\n');
  }, [tally, current]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  if (!config || !tally || !current || !point) return <main className="narrow"><p className="muted center">불러오는 중…</p></main>;

  return (
    <main className="narrow stack">
      <div className="card stack">
        <h1>공지 생성</h1>
        <PointPicker config={config} value={point} onChange={setPoint} />
        {current.total.missing > 0 && <div className="alert warn">{current.total.missing}개 투표소가 이 시점에 미입력입니다. 직전 값을 이어서 계산한 수치입니다.</div>}
      </div>
      <div className="card stack">
        <div className="row between">
          <h2>공지 문구</h2>
          <span className="muted small">{noticeDate(current.date, current.time)}</span>
        </div>
        <pre className="notice">{text}</pre>
        <button className="btn primary block" onClick={copy}>{copied ? '복사됨 ✓' : '문구 복사'}</button>
      </div>
      <div className="card stack">
        <div className="row between">
          <h2>공지 이미지</h2>
          <span className="muted small">1080×1350 PNG · 총 투표율 1장 + 선거구 3장</span>
        </div>
        {imgError && <div className="alert danger">{imgError}</div>}
        {rendering && !images && <p className="muted small">이미지를 만드는 중…</p>}
        {images && (
          <>
            <button className="btn primary block" onClick={async () => {
              const all = [images.total, ...images.pages];
              for (let i = 0; i < all.length; i++) { await downloadCanvas(all[i], imageFilename(current, i + 1)); await new Promise((r) => setTimeout(r, 400)); }
            }}>4장 한 번에 저장</button>
            <div className="img-grid">
              {[images.total, ...images.pages].map((c, i) => (
                <figure key={i} className="img-cell">
                  <img src={c.toDataURL('image/png')} alt={`공지 이미지 ${i + 1}`} />
                  <figcaption className="row between">
                    <span className="small muted">{i === 0 ? '총 투표율' : `선거구 ${i}`}</span>
                    <button className="btn sm" onClick={() => downloadCanvas(c, imageFilename(current, i + 1))}>저장</button>
                  </figcaption>
                </figure>
              ))}
            </div>
            <p className="muted small">휴대폰에서는 이미지를 길게 눌러 저장할 수도 있습니다. 브라우저가 여러 파일 다운로드를 물어보면 허용하세요.</p>
          </>
        )}
      </div>
      <div className="card stack">
        <h2>CSV 내보내기</h2>
        <p className="muted small">투표소 × 시점 누적값, 휴학생 수, 증가분, 투표율, 입력자, 확정 여부. 엑셀에서 바로 열립니다.</p>
        <a className="btn block" href="/api/export.csv" download>CSV 내려받기</a>
      </div>
    </main>
  );
}
