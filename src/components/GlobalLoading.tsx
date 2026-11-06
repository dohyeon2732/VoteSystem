import { useEffect, useState, useSyncExternalStore } from 'react';
import { getPending, subscribe } from '../app/loading';

const SHOW_AFTER_MS = 250; // 빠른 응답에는 깜빡이지 않도록

/** 서버 요청이 진행 중이면 화면 가운데에 로딩 표시 (배경 자동 갱신은 제외) */
export default function GlobalLoading() {
  const pending = useSyncExternalStore(subscribe, getPending);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (pending === 0) { setShow(false); return; }
    const t = setTimeout(() => setShow(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [pending > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!show) return null;
  return (
    <div className="global-loading" role="status" aria-live="polite">
      <div className="global-loading-box">
        <span className="spinner" aria-hidden="true" />
        불러오는 중…
      </div>
    </div>
  );
}
