import { useCallback, useEffect, useRef, useState } from 'react';

/** Poll a loader every `ms`; pauses when the tab is hidden. */
export function usePolling<T>(loader: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const load = useCallback(async () => {
    try { setData(await loader()); setError(null); } catch (e) { setError((e as Error).message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => { if (!cancelled && !document.hidden) await load(); };
    tick();
    timer.current = window.setInterval(tick, ms);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; if (timer.current) clearInterval(timer.current); document.removeEventListener('visibilitychange', onVis); };
  }, [load, ms]);
  return { data, error, reload: load };
}
