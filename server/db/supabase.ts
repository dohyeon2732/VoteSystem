import { createClient } from '@supabase/supabase-js';
import type { Db, Where } from './types.js';

export function createSupabaseDb(url: string, serviceKey: string): Db {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
  const applyWhere = (q: any, where?: Where) => {
    for (const [k, v] of Object.entries(where ?? {})) q = v === null ? q.is(k, null) : q.eq(k, v);
    return q;
  };
  const check = <T>(res: { data: T; error: { message: string } | null }) => {
    if (res.error) throw new Error('Supabase: ' + res.error.message);
    return res.data;
  };
  return {
    async all<T>(table: string, where?: Where, orderBy?: string) {
      let q = applyWhere(sb.from(table).select('*'), where);
      if (orderBy) {
        for (const part of orderBy.split(',')) {
          const [col, dir] = part.trim().split(/\s+/);
          q = q.order(col, { ascending: (dir ?? 'asc').toLowerCase() !== 'desc' });
        }
      }
      return check(await q) as T[];
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
  };
}
