/**
 * 화면 가운데 로딩 표시를 위한 진행 중 요청 수.
 * 자동 갱신(폴링) 같은 배경 요청은 runSilently로 감싸 표시에서 뺀다.
 */
let pending = 0;
let silentDepth = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const isSilent = () => silentDepth > 0;

/** fn 안에서 동기적으로 시작한 api() 호출은 로딩 표시를 띄우지 않는다. */
export function runSilently<T>(fn: () => Promise<T>): Promise<T> {
  silentDepth++;
  try { return fn(); } finally { silentDepth--; }
}

export function trackStart() { pending++; emit(); }
export function trackEnd() { pending = Math.max(0, pending - 1); emit(); }
export const getPending = () => pending;
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
