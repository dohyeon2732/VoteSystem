import { useState } from 'react';
import { api } from '../apis';

export const PLEDGE_TEXT =
  '본인은 선거인명부를 제58대 총학생회 선거의 투표 관리 목적으로만 열람하며, 열람한 정보를 촬영·기록·외부에 전달하지 않겠습니다. 모든 조회는 기록되며, 위반 시 선거관리위원회 규정에 따른 책임을 집니다.';

/** 개인정보 취급 서약 (FR-94). 동의 전에는 명부 API가 거부된다. */
export default function Pledge({ onDone }: { onDone: () => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const agree = async () => {
    setBusy(true); setErr(null);
    try { await api('/roster/pledge', { body: { agree: true } }); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card stack">
      <h1>개인정보 취급 서약</h1>
      <p className="muted small">선거인명부 기능을 처음 쓰기 전에 한 번 동의합니다. 동의 시각이 기록됩니다.</p>
      <blockquote style={{ margin: 0, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 10, lineHeight: 1.7 }}>{PLEDGE_TEXT}</blockquote>
      <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: 20, height: 20, marginTop: 2 }} />
        <span>위 내용을 읽었고 서약합니다.</span>
      </label>
      {err && <div className="alert danger">{err}</div>}
      <button className="btn primary block" disabled={!checked || busy} onClick={agree}>서약하고 시작</button>
    </div>
  );
}
