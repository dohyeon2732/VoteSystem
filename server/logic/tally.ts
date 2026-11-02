import type { District, ElectionDay, Entry, Slot, Station } from '../db/types.js';
import { slotEpoch } from './time.js';

export interface PointKey { date: string; time: string; epoch: number }

export interface StationPoint {
  station_id: string;
  cumulative: number;
  leave_cumulative: number;
  has_slot: boolean;        // 이 시점에 이 투표소의 집계 시점이 있는가
  entered: boolean;         // 그 시점 값이 입력되었는가
  confirmed: boolean;
  entry_id: string | null;
  last_entry_at: string | null;
  last_entry_by: string | null;
  carried_from: string | null; // 미입력이라 이어서 쓴 값의 출처 (date time)
}

export interface DistrictPoint {
  district_id: string;
  name: string;
  base_voters: number;
  voters: number;
  cumulative: number;
  leave_cumulative: number;
  pct: number;
  delta: number;
  missing: number;          // 미입력 투표소 수
  last_entry_at: string | null;
  last_entry_by: string | null;
  stations: StationPoint[];
}

export interface TallyPoint {
  date: string;
  time: string;
  epoch: number;
  total: { base_voters: number; voters: number; cumulative: number; leave_cumulative: number; pct: number; delta: number; missing: number };
  districts: DistrictPoint[];
}

export function pct(cumulative: number, voters: number): number {
  if (voters <= 0) return 0;
  return Math.round((cumulative / voters) * 10000) / 100;
}

export function computeTally(input: {
  days: ElectionDay[];
  districts: District[];
  stations: Station[];
  slots: Slot[];
  entries: Entry[];
  extensionEnabled: boolean;
}): TallyPoint[] {
  const activeDays = input.days.filter((d) => !d.is_extension || input.extensionEnabled).sort((a, b) => a.sort - b.sort);
  const dayById = new Map(activeDays.map((d) => [d.id, d]));
  const slotById = new Map(input.slots.map((s) => [s.id, s]));

  // 시점 축: 활성 일자의 모든 투표소 시점 합집합
  const keyMap = new Map<string, PointKey>();
  for (const s of input.slots) {
    const day = dayById.get(s.day_id);
    if (!day) continue;
    const k = `${day.date} ${s.time}`;
    if (!keyMap.has(k)) keyMap.set(k, { date: day.date, time: s.time, epoch: slotEpoch(day.date, s.time) });
  }
  const points = [...keyMap.values()].sort((a, b) => a.epoch - b.epoch);

  // 투표소별 입력을 시각순으로
  type Dated = { entry: Entry; epoch: number; date: string; time: string };
  const byStation = new Map<string, Dated[]>();
  for (const e of input.entries) {
    const slot = slotById.get(e.slot_id);
    const day = slot ? dayById.get(slot.day_id) : undefined;
    if (!slot || !day) continue;
    const list = byStation.get(e.station_id) ?? [];
    list.push({ entry: e, epoch: slotEpoch(day.date, slot.time), date: day.date, time: slot.time });
    byStation.set(e.station_id, list);
  }
  for (const list of byStation.values()) list.sort((a, b) => a.epoch - b.epoch);

  const slotsByStation = new Map<string, Slot[]>();
  for (const s of input.slots) {
    const list = slotsByStation.get(s.station_id) ?? [];
    list.push(s);
    slotsByStation.set(s.station_id, list);
  }

  const sortedDistricts = [...input.districts].sort((a, b) => a.sort - b.sort);
  const sortedStations = [...input.stations].sort((a, b) => a.sort - b.sort);
  const out: TallyPoint[] = [];
  let prevTotal = 0;
  const prevDistrict = new Map<string, number>();

  for (const p of points) {
    const districts: DistrictPoint[] = [];
    let tBase = 0, tVoters = 0, tCum = 0, tLeave = 0, tMissing = 0;
    for (const d of sortedDistricts) {
      const stationPoints: StationPoint[] = [];
      for (const st of sortedStations.filter((s) => s.district_id === d.id)) {
        const dated = byStation.get(st.id) ?? [];
        const slotHere = (slotsByStation.get(st.id) ?? []).find((s) => {
          const day = dayById.get(s.day_id);
          return day && day.date === p.date && s.time === p.time;
        });
        let latest: Dated | null = null;
        for (const x of dated) { if (x.epoch <= p.epoch) latest = x; else break; }
        const exact = latest && latest.epoch === p.epoch ? latest : null;
        stationPoints.push({
          station_id: st.id,
          cumulative: latest?.entry.cumulative ?? 0,
          leave_cumulative: latest?.entry.leave_cumulative ?? 0,
          has_slot: !!slotHere,
          entered: !!exact,
          confirmed: exact?.entry.confirmed ?? false,
          entry_id: exact?.entry.id ?? null,
          last_entry_at: latest?.entry.entered_at ?? null,
          last_entry_by: latest?.entry.entered_by_name ?? null,
          carried_from: !exact && latest ? `${latest.date} ${latest.time}` : null,
        });
      }
      const cum = stationPoints.reduce((a, s) => a + s.cumulative, 0);
      const leave = stationPoints.reduce((a, s) => a + s.leave_cumulative, 0);
      const missing = stationPoints.filter((s) => s.has_slot && !s.entered).length;
      const voters = d.base_voters + leave;
      const lastAt = stationPoints.map((s) => s.last_entry_at).filter(Boolean).sort().at(-1) ?? null;
      const lastBy = stationPoints.find((s) => s.last_entry_at === lastAt)?.last_entry_by ?? null;
      districts.push({
        district_id: d.id, name: d.name, base_voters: d.base_voters, voters, cumulative: cum, leave_cumulative: leave,
        pct: pct(cum, voters), delta: cum - (prevDistrict.get(d.id) ?? 0), missing,
        last_entry_at: lastAt, last_entry_by: lastBy, stations: stationPoints,
      });
      prevDistrict.set(d.id, cum);
      tBase += d.base_voters; tVoters += voters; tCum += cum; tLeave += leave; tMissing += missing;
    }
    out.push({
      date: p.date, time: p.time, epoch: p.epoch,
      total: { base_voters: tBase, voters: tVoters, cumulative: tCum, leave_cumulative: tLeave, pct: pct(tCum, tVoters), delta: tCum - prevTotal, missing: tMissing },
      districts,
    });
    prevTotal = tCum;
  }
  return out;
}
