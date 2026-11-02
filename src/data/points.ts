import { slotEpoch, type Config } from '../apis';
import type { Point } from '../components/PointPicker';

/** All (date,time) points in order, honoring the extension toggle. */
export function allPoints(config: Config): (Point & { epoch: number })[] {
  const days = config.days.filter((d) => !d.is_extension || config.election.extension_enabled);
  const out: (Point & { epoch: number })[] = [];
  for (const d of days) {
    for (const t of [...new Set(config.slots.filter((s) => s.day_id === d.id).map((s) => s.time))]) {
      out.push({ date: d.date, time: t, epoch: slotEpoch(d.date, t) });
    }
  }
  return out.sort((a, b) => a.epoch - b.epoch);
}

/** Latest point whose time is within 10 minutes from now (or the first point before the election starts). */
export function currentPoint(config: Config): Point | null {
  const pts = allPoints(config);
  if (pts.length === 0) return null;
  const now = Date.now() + 10 * 60 * 1000;
  let cur = pts[0];
  for (const p of pts) { if (p.epoch <= now) cur = p; else break; }
  return { date: cur.date, time: cur.time };
}
