import { useCallback, useEffect, useRef, useState } from 'react';
import { runSilently } from '../app/loading';

/** Poll a loader every `ms`; pauses when the tab is hidden.
 *  첫 로드만 화면 가운데 로딩 표시를 띄우고, 이후 자동 갱신은 조용히 한다. */
export function usePolling<T>(loader: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const loaded = useRef(false);
  const load = useCallback(async (silent = false) => {
    try { setData(await (silent ? runSilently(loader) : loader())); setError(null); } catch (e) { setError((e as Error).message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    let cancelled = false;
    loaded.current = false;
    const tick = async () => {
      if (cancelled || document.hidden) return;
      const silent = loaded.current;
      loaded.current = true;
      await load(silent);
    };
    tick();
    timer.current = window.setInterval(tick, ms);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; if (timer.current) clearInterval(timer.current); document.removeEventListener('visibilitychange', onVis); };
  }, [load, ms]);
  const reload = useCallback(() => load(false), [load]);
  return { data, error, reload };
}
