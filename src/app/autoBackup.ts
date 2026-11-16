/**
 * 체크 기록 백업 (FR-96) 과 30분 자동 백업 (FR-96a).
 * 백업 자료를 3,000건씩 받아 브라우저에서 CSV로 합친다 (Vercel 응답 한도 4.5MB).
 * 자동 백업은 화면을 옮겨도 계속 돌도록 모듈 전역 상태로 둔다. 탭을 닫거나 PC가 잠들면 멈춘다.
 */
import { api, type Station } from '../apis';
import { downloadText, toCsv } from '../data/sheet';
import { runSilently } from './loading';

const INTERVAL_MS = 30 * 60_000;
const RETRY_MS = 5 * 60_000;

interface BackupPage { events: Record<string, unknown>[]; windows: Record<string, unknown>[]; total: number; page: number }

export interface AutoBackupState {
  on: boolean;
  /** 폴더에 바로 저장(true) / 일반 다운로드(false) */
  toFolder: boolean;
  folderName: string | null;
  lastAt: number | null;
  lastFile: string | null;
  nextAt: number | null;
  count: number;
  error: string | null;
  running: boolean;
}

let state: AutoBackupState = { on: false, toFolder: false, folderName: null, lastAt: null, lastFile: null, nextAt: null, count: 0, error: null, running: false };
const listeners = new Set<() => void>();
let timer: number | null = null;
let dir: any = null; // FileSystemDirectoryHandle
let stations: Station[] = [];
let wakeLock: any = null;

const set = (patch: Partial<AutoBackupState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
export const getAutoBackup = () => state;
export function subscribeAutoBackup(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export const folderPickerSupported = () => typeof (window as any).showDirectoryPicker === 'function';

function fileName(now = Date.now()) {
  const k = new Date(now + 9 * 3600 * 1000).toISOString(); // KST
  return `roster_backup_${k.slice(5, 10)}_${k.slice(11, 13)}${k.slice(14, 16)}.csv`;
}

/** 서버에서 전부 받아 백업 CSV 내용을 만든다. 복원 화면이 읽는 형식과 같다. */
export async function buildBackupCsv(stationList: Station[]): Promise<{ csv: string; events: number; windows: number }> {
  const sname = (id: unknown) => stationList.find((s) => s.id === id)?.name ?? String(id ?? '');
  const seen = new Set<unknown>();
  const events: Record<string, unknown>[] = [];
  let windows: Record<string, unknown>[] = [];
  for (let offset = 0; ; ) {
    const p = await api<BackupPage>(`/roster/backup/data?offset=${offset}`);
    if (offset === 0) windows = p.windows;
    for (const e of p.events) if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
    offset += p.events.length;
    if (p.events.length < p.page) break;
  }
  const rows: unknown[][] = [['구분', '시각', '투표소', '종류', '학번해시', '구간', '데이터']];
  for (const w of windows) rows.push(['마감', w.boundary_at, sname(w.station_id), w.status, '', w.id, JSON.stringify(w)]);
  for (const e of events) rows.push(['체크', e.at, sname(e.station_id), e.kind, e.voter_sid_hash, e.window_id ?? '', JSON.stringify(e)]);
  return { csv: toCsv(rows), events: events.length, windows: windows.length };
}

/** 손으로 한 번 받기 */
export async function downloadBackupNow(stationList: Station[]) {
  const b = await buildBackupCsv(stationList);
  const name = fileName();
  downloadText(name, b.csv);
  await api('/roster/backup/done', { body: { auto: false, events: b.events, windows: b.windows } });
  return { ...b, name };
}

async function keepAwake() {
  try { wakeLock = await (navigator as any).wakeLock?.request('screen'); } catch { /* 지원하지 않거나 거부됨 */ }
}
function onVisible() { if (state.on && !document.hidden) keepAwake(); }

async function tick() {
  if (!state.on || state.running) return;
  set({ running: true });
  let delay = INTERVAL_MS;
  try {
    const b = await runSilently(() => buildBackupCsv(stations));
    const name = fileName();
    if (dir) {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(b.csv);
      await w.close();
    } else {
      downloadText(name, b.csv);
    }
    // 저장 기록 + 로그인 연장 (자정까지만)
    await runSilently(() => api('/roster/backup/done', { body: { auto: true, events: b.events, windows: b.windows } }));
    set({ lastAt: Date.now(), lastFile: name, count: state.count + 1, error: null });
  } catch (e) {
    delay = RETRY_MS;
    set({ error: `자동 백업 실패: ${(e as Error).message}` });
  } finally {
    if (state.on) {
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(tick, delay);
      set({ running: false, nextAt: Date.now() + delay });
    } else set({ running: false });
  }
}

/** 자동 백업 켜기. Chrome·Edge는 저장할 폴더를 먼저 고른다 (사용자 클릭 안에서 불러야 함). */
export async function startAutoBackup(stationList: Station[]) {
  stations = stationList;
  dir = null;
  if (folderPickerSupported()) {
    dir = await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'roster-backup' }); // 취소하면 예외 → 켜지지 않음
  }
  set({ on: true, toFolder: !!dir, folderName: dir?.name ?? null, error: null, count: 0, lastAt: null, lastFile: null });
  document.addEventListener('visibilitychange', onVisible);
  keepAwake();
  await tick();
}

export function stopAutoBackup() {
  if (timer) clearTimeout(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
  set({ on: false, nextAt: null, error: null, running: false });
}
