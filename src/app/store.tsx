import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Config, type Me } from '../apis';

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

  const refreshConfig = useCallback(async () => {
    try { setConfig(await api<Config>('/config')); } catch { /* ignore */ }
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
    setMe: (m) => { setMeState(m); if (!m) setConfig(null); },
    theme, setTheme: setThemeState,
  }), [me, config, refreshConfig, theme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useStore = () => useContext(Ctx);
