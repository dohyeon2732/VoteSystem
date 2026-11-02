import type { Db } from './types.js';

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (async () => {
      // 대시보드에서 "REST URL"(…/rest/v1)이나 끝에 /가 붙은 값을 넣어도 동작하도록 정리
      const url = (process.env.SUPABASE_URL ?? '').trim().replace(/\/(rest|auth|storage)\/v1\/?$/, '').replace(/\/+$/, '');
      const key = (process.env.SUPABASE_SERVICE_KEY ?? '').trim();
      if (url && key) {
        const { createSupabaseDb } = await import('./supabase.js');
        return createSupabaseDb(url, key);
      }
      const { createSqliteDb } = await import('./sqlite.js');
      return createSqliteDb(process.env.SQLITE_PATH ?? 'data/vote.sqlite');
    })();
  }
  return dbPromise;
}
