import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Config, type Me } from '../apis';
import { runSilently } from './loading';

interface Store {
  me: Me | null | undefined; // undefined = loading
  config: Config | null;
  refreshConfig: () => Promise<void>;
  setMe: (m: Me | null) => void;
  theme: 'light' | 'dark';
  setTheme: (t: 'light' | 'dark') => void;
}

const Ctx = createContext<Store>(null!);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null | undefined>(undefined);
  const [config, setConfig] = useState<Config | null>(null);
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => {
    try { return (localStorage.getItem('theme') as 'light' | 'dark') || 'light'; } catch { return 'light'; }
  });

  const hasConfig = useRef(false);
  // 처음 한 번만 로딩 표시, 이후 갱신은 조용히
  const refreshConfig = useCallback(async () => {
    try {
      const load = () => api<Config>('/config');
      const c = await (hasConfig.current ? runSilently(load) : load());
      hasConfig.current = true;
      setConfig(c);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    api<Me>('/me').then((m) => { setMeState(m); }).catch(() => setMeState(null));
  }, []);
  useEffect(() => { if (me) refreshConfig(); }, [me, refreshConfig]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);

  const value = useMemo<Store>(() => ({
    me, config, refreshConfig,
    setMe: (m) => { setMeState(m); if (!m) { setConfig(null); hasConfig.current = false; } },
    theme, setTheme: setThemeState,
  }), [me, config, refreshConfig, theme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useStore = () => useContext(Ctx);
