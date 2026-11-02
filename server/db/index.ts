import type { Db } from './types.js';

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_KEY;
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
