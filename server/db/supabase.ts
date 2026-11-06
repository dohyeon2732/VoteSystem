import { createClient } from '@supabase/supabase-js';
import type { Db, RosterCount, StationCounts, VoteOps, Where } from './types.js';

const PAGE = 1000; // PostgREST 기본 최대 행 수

export function createSupabaseDb(url: string, serviceKey: string): Db {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
  const applyWhere = (q: any, where?: Where) => {
    for (const [k, v] of Object.entries(where ?? {})) q = v === null ? q.is(k, null) : q.eq(k, v);
    return q;
  };
  const applyOrder = (q: any, orderBy?: string) => {
    for (const part of (orderBy ?? 'id').split(',')) {
      const [col, dir] = part.trim().split(/\s+/);
      q = q.order(col, { ascending: (dir ?? 'asc').toLowerCase() !== 'desc' });
    }
    return q;
  };
  const check = <T>(res: { data: T; error: { message: string } | null }) => {
    if (res.error) throw new Error('Supabase: ' + res.error.message);
    return res.data;
  };
  const rpc = async <T>(fn: string, args?: Record<string, unknown>) => check(await sb.rpc(fn, args ?? {})) as T;

  const votes: VoteOps = {
    issue: (i) => rpc('vote_issue', { p: i }),
    cancel: (c) => rpc('vote_cancel', { p: c }),
    async assignWindow(stationId, windowId, boundaryAt) {
      await rpc('vote_assign_window', { p_station: stationId, p_window: windowId, p_boundary: boundaryAt });
    },
    windowCounts: (windowId) => rpc('vote_window_counts', { p_window: windowId }),
    liveCounts: () => rpc<StationCounts[]>('vote_live_counts'),
    rosterCounts: () => rpc<RosterCount[]>('vote_roster_counts'),
    async resetChecks() { await rpc('vote_reset_checks'); },
    rebuildVoterState: () => rpc<number>('vote_rebuild_voter_state'),
    async purge() { await rpc('vote_purge'); },
  };

  return {
    votes,
    async all<T>(table: string, where?: Where, orderBy?: string, limit?: number) {
      if (limit) {
        const q = applyOrder(applyWhere(sb.from(table).select('*'), where), orderBy).limit(limit);
        return check(await q) as T[];
      }
      // 1,000행 제한을 넘는 테이블도 빠짐없이 읽도록 나눠 읽는다
      const out: T[] = [];
      for (let from = 0; ; from += PAGE) {
        const q = applyOrder(applyWhere(sb.from(table).select('*'), where), orderBy).range(from, from + PAGE - 1);
        const rows = check(await q) as T[];
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    },
    async get<T>(table: string, where: Where) {
      const rows = check(await applyWhere(sb.from(table).select('*'), where).limit(1)) as T[];
      return rows[0] ?? null;
    },
    async insert(table, row) {
      check(await sb.from(table).insert(row as any));
      return row;
    },
    async update(table, where, patch) {
      check(await applyWhere(sb.from(table).update(patch as any), where));
    },
    async remove(table, where) {
      check(await applyWhere(sb.from(table).delete(), where));
    },
    async insertMany(table, rows) {
      for (let i = 0; i < rows.length; i += 500) check(await sb.from(table).insert(rows.slice(i, i + 500) as any));
    },
    async removeIds(table, ids) {
      // URL 길이 제한을 피하려고 100개씩
      for (let i = 0; i < ids.length; i += 100) check(await sb.from(table).delete().in('id', ids.slice(i, i + 100)));
    },
    async removeAll(table) {
      // PostgREST는 조건 없는 DELETE를 막으므로 항상 참인 조건을 건다
      check(await sb.from(table).delete().not('id', 'is', null));
    },
    async count(table, where) {
      const res = await applyWhere(sb.from(table).select('id', { count: 'exact', head: true }), where);
      if (res.error) throw new Error('Supabase: ' + res.error.message);
      return res.count ?? 0;
    },
    async allIn<T>(table: string, column: string, values: string[], where?: Where) {
      const out: T[] = [];
      // 해시 값(64자)도 URL 길이 안에 들도록 50개씩
      for (let i = 0; i < values.length; i += 50) {
        const chunk = values.slice(i, i + 50);
        if (chunk.length) out.push(...(check(await applyWhere(sb.from(table).select('*'), where).in(column, chunk)) as T[]));
      }
      return out;
    },
  };
}
