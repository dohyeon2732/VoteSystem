import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { api, type Me } from '../apis';
import { useStore } from '../app/store';

export default function Login() {
  const { setMe } = useStore();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const me = await api<Me>('/login', { body: { name, code } });
      setMe(me);
      nav(loc.state?.from ?? '/dashboard', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <motion.form
        className="card login-card stack"
        onSubmit={submit}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
      >
        <div>
          <img src="/logo.svg" alt="" className="login-logo" />
          <h1>투표율 집계 시스템</h1>
          <p className="muted small">중앙선거관리위원회 전용. 이름과 발급받은 코드로 들어옵니다.</p>
        </div>
        <div className="field">
          <label htmlFor="name">이름</label>
          <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus required />
        </div>
        <div className="field">
          <label htmlFor="code">접근 코드</label>
          <input id="code" className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoComplete="off" autoCapitalize="characters" spellCheck={false} style={{ letterSpacing: '0.15em', fontFamily: 'ui-monospace, Menlo, monospace' }} required />
        </div>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <button className="btn primary block" disabled={busy || !name || !code}>{busy ? '확인 중…' : '로그인'}</button>
        <p className="muted small center">세션은 2시간 뒤 자동으로 만료됩니다.</p>
      </motion.form>
    </div>
  );
}
