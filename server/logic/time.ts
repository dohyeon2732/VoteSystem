/** All election times are Asia/Seoul (UTC+9, no DST). */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function slotEpoch(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 'YYYY-MM-DD' → 월/화/... */
export function weekdayKo(date: string): string {
  const d = new Date(slotEpoch(date, '12:00') + KST_OFFSET_MS);
  return ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()];
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 시작 + 2h 간격 + 마감 시각. 09:00~18:00 → 11,13,15,17,18 / 18:30~22:30 → 20:30, 22:30 */
export function generateSlotTimes(open: string, close: string, intervalMin = 120): { time: string; isClose: boolean }[] {
  const o = timeToMinutes(open), c = timeToMinutes(close);
  const out: { time: string; isClose: boolean }[] = [];
  for (let t = o + intervalMin; t < c; t += intervalMin) out.push({ time: minutesToTime(t), isClose: false });
  out.push({ time: close, isClose: true });
  return out;
}
