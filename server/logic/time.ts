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

/** 기본 집계 시각. 각 투표소는 운영시간 안에 드는 시각 + 마감 시각을 시점으로 가진다. */
export const DEFAULT_TALLY_TIMES = ['12:00', '15:00', '18:00'];

/** 공통 집계 시각 목록 → 투표소 시점. 09:00~18:00 → 12:00, 15:00, 18:00(마감) / 18:30~22:30 → 22:30(마감) */
export function generateSlotTimes(open: string, close: string, tallyTimes: string[]): { time: string; isClose: boolean }[] {
  const out = [...new Set(tallyTimes)].filter((t) => t > open && t < close).sort().map((time) => ({ time, isClose: false }));
  out.push({ time: close, isClose: true });
  return out;
}

/** 현재 슬롯에서 공통 집계 시각 목록을 읽는다 (마감 시점 제외). */
export function tallyTimesFromSlots(slots: { time: string; is_close: boolean }[]): string[] {
  return [...new Set(slots.filter((s) => !s.is_close).map((s) => s.time))].sort();
}
