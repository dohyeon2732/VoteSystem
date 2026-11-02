import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config } from '../apis';
import type { Point } from '../components/PointPicker';
import { allPoints } from '../data/points';

const LEAD_MS = 10 * 60 * 1000; // 집계 시각 10분 전부터 그 시점을 "현재"로 본다

/** 지금 시각 기준 현재 시점. 선거 시작 전이면 null. */
export function livePoint(config: Config): Point | null {
  const pts = allPoints(config);
  const now = Date.now() + LEAD_MS;
  let cur: Point | null = null;
  for (const p of pts) { if (p.epoch <= now) cur = { date: p.date, time: p.time }; else break; }
  return cur;
}

const same = (a: Point | null, b: Point | null) => !!a && !!b && a.date === b.date && a.time === b.time;

/**
 * 모든 화면이 공유하는 시점 선택 규칙.
 * - 기본은 현재 시점을 따라가며, 시각이 바뀌면(예: 13:00 도달) 자동으로 넘어간다.
 * - 사용자가 직접 고르면 따라가기를 멈추고, resetToLive()로 다시 따라간다.
 * - 선거 시작 전에는 fallback(입력이 있는 마지막 시점 등)을 쓴다.
 */
export function useLivePoint(config: Config | null, fallback: Point | null) {
  const [point, setPointState] = useState<Point | null>(null);
  const [following, setFollowing] = useState(true);
  const lastLive = useRef<Point | null>(null);
  const [isLive, setIsLive] = useState(false);

  const sync = useCallback(() => {
    if (!config) return;
    const real = livePoint(config);
    setIsLive(!!real);
    const live = real ?? fallback;
    if (!live) return;
    if (!same(live, lastLive.current)) {
      lastLive.current = live;
      if (following) setPointState(live);
    } else if (following && !point) {
      setPointState(live);
    }
  }, [config, fallback, following, point]);

  useEffect(() => { sync(); }, [sync]);
  useEffect(() => {
    const t = setInterval(sync, 15000);
    const onVis = () => { if (!document.hidden) sync(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [sync]);

  const setPoint = useCallback((p: Point) => {
    setPointState(p);
    setFollowing(same(p, lastLive.current));
  }, []);
  const resetToLive = useCallback(() => {
    setFollowing(true);
    if (lastLive.current) setPointState(lastLive.current);
  }, []);

  return { point, setPoint, following, resetToLive, isLive };
}
