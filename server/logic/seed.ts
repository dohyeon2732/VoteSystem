import { randomUUID } from 'node:crypto';
import type { Db, District, Election, ElectionDay, Member, Slot, Station } from '../db/types.js';
import { DEFAULT_TALLY_TIMES, generateSlotTimes, nowIso, tallyTimesFromSlots } from './time.js';
import { hashCode } from '../auth.js';

const DAYS = [
  { date: '2026-11-23', ext: false },
  { date: '2026-11-24', ext: false },
  { date: '2026-11-25', ext: false },
  { date: '2026-11-26', ext: true },
];

const DISTRICTS: { name: string; stations?: { name: string; open: string; close: string }[] }[] = [
  { name: '건축대학' },
  { name: '경영대학' },
  {
    name: '공과대학',
    stations: [
      { name: '공과대학1(왼)', open: '09:00', close: '18:00' },
      { name: '공과대학2(중앙)', open: '09:00', close: '18:00' },
      { name: '공과대학3(법학관)', open: '18:30', close: '22:30' },
    ],
  },
  { name: '국제대학' },
  { name: '문과대학' },
  { name: '부동산과학원' },
  { name: '사범대학' },
  { name: '사회과학대학' },
  { name: '상허교양대학' },
  { name: '생명과학대학' },
  { name: '수의과대학' },
  { name: '예술디자인대학' },
  { name: '융합과학기술원' },
  { name: '이과대학' },
];

/** 현재 DB의 공통 집계 시각 목록 (마감 제외). 시점이 하나도 없으면 기본값. */
export async function currentTallyTimes(db: Db): Promise<string[]> {
  const slots = await db.all<{ time: string; is_close: boolean }>('slot');
  return slots.length ? tallyTimesFromSlots(slots) : [...DEFAULT_TALLY_TIMES];
}

/** 투표소들의 시점을 공통 집계 시각 기준으로 다시 만든다. 입력값이 있는 시점은 지우지 않고, 남은 개수를 돌려준다.
 *  Supabase에서는 요청 하나하나가 왕복이라, 한 번 읽고 묶어서 쓴다. */
export async function regenerateSlots(db: Db, stations: Station[], tallyTimes: string[]): Promise<number> {
  const [days, slots, entries] = await Promise.all([
    db.all<ElectionDay>('election_day'),
    db.all<Slot>('slot'),
    db.all<{ slot_id: string }>('entry'),
  ]);
  const used = new Set(entries.map((e) => e.slot_id));
  const inserts: Slot[] = [];
  const removes: string[] = [];
  let kept = 0;
  for (const station of stations) {
    const existing = slots.filter((x) => x.station_id === station.id);
    const wanted = new Set<string>();
    for (const day of days) {
      for (const { time, isClose } of generateSlotTimes(station.open_time, station.close_time, tallyTimes)) {
        wanted.add(`${day.id}|${time}`);
        const found = existing.find((x) => x.day_id === day.id && x.time === time);
        if (!found) inserts.push({ id: randomUUID(), station_id: station.id, day_id: day.id, time, is_close: isClose });
        else if (!!found.is_close !== isClose) await db.update('slot', { id: found.id }, { is_close: isClose });
      }
    }
    for (const x of existing) {
      if (wanted.has(`${x.day_id}|${x.time}`)) continue;
      if (used.has(x.id)) kept++;
      else removes.push(x.id);
    }
  }
  await db.removeIds('slot', removes);
  await db.insertMany('slot', inserts);
  return kept;
}

export async function regenerateSlotsForStation(db: Db, station: Station, tallyTimes: string[]): Promise<number> {
  return regenerateSlots(db, [station], tallyTimes);
}

export async function ensureSeed(db: Db): Promise<void> {
  const election = await db.get<Election>('election', { id: 'main' });
  if (!election) {
    await db.insert<Election>('election', {
      id: 'main',
      name: '건국대학교 제58대 총학생회 선거',
      threshold_pct: 50,
      extension_enabled: false,
      input_locked: false,
      enforce_time_window: true,
      result_announced_on: null,
      retention_days: 7,
      purged_at: null,
      roster_upload: null,
      last_backup_at: null,
    });
  }
  const days = await db.all<ElectionDay>('election_day');
  if (days.length === 0) {
    for (const [i, d] of DAYS.entries()) {
      await db.insert<ElectionDay>('election_day', { id: `day-${d.date}`, date: d.date, is_extension: d.ext, sort: i });
    }
  }
  const districts = await db.all<District>('district');
  if (districts.length === 0) {
    let stationSort = 0;
    for (const [i, d] of DISTRICTS.entries()) {
      const district: District = { id: randomUUID(), name: d.name, sort: i, base_voters: 0 };
      await db.insert('district', district);
      const stations = d.stations ?? [{ name: d.name, open: '09:00', close: '18:00' }];
      for (const s of stations) {
        const station: Station = {
          id: randomUUID(), district_id: district.id, name: s.name, sort: stationSort++, open_time: s.open, close_time: s.close,
        };
        await db.insert('station', station);
        await regenerateSlotsForStation(db, station, DEFAULT_TALLY_TIMES);
      }
    }
  }
  const admins = await db.all<Member>('member', { role: 'admin' });
  if (admins.length === 0) {
    const name = process.env.ADMIN_NAME ?? '관리자';
    const code = process.env.ADMIN_CODE ?? 'ADMIN123';
    await db.insert<Member>('member', {
      id: randomUUID(), name, role: 'admin', code_hash: hashCode(code), code_version: 1, active: true,
      created_at: nowIso(), last_login_at: null, failed_count: 0, locked_until: null,
    });
  }
}
