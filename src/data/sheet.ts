/** 엑셀(.xlsx)·CSV 파일을 브라우저 안에서만 읽는다. 파일은 서버로 보내지 않는다 (명세 15.2). */

const pad = (n: number) => String(n).padStart(2, '0');

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // 엑셀 시각 전용 칸은 1899-12-30 기준 날짜로 들어온다
    if (v.getUTCFullYear() < 1901) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

/** UTF-8로 읽어 보고 깨지면 엑셀 기본 인코딩(EUC-KR/CP949)으로 다시 읽는다. */
async function decodeText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('euc-kr').decode(buf); }
  return text.replace(/^﻿/, '');
}

export async function readTable(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/browser'); // 엑셀을 올릴 때만 불러온다
    const data = await readSheet(file);
    return data.map((r) => r.map(cellToString)).filter((r) => r.some((x) => x !== ''));
  }
  if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(await decodeText(file));
  throw new Error('엑셀(.xlsx) 또는 CSV 파일만 올릴 수 있습니다. 구버전 .xls는 엑셀에서 .xlsx로 다시 저장하세요.');
}

/** 엑셀 시각 값(0.375 = 09:00, "9:00", "09:00:00")을 HH:MM으로 */
export function toHM(v: string): string {
  const s = v.trim();
  if (/^0?\.\d+$|^0$/.test(s)) { const m = Math.round(Number(s) * 24 * 60); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? `${pad(Number(m[1]))}:${m[2]}` : s;
}

/** "2026.11.23", "11/23", "2026-11-23" → YYYY-MM-DD (연도가 없으면 defaultYear) */
export function toYMD(v: string, defaultYear = 2026): string {
  const s = v.trim();
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  m = /^(\d{1,2})[-./](\d{1,2})/.exec(s);
  if (m) return `${defaultYear}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
  return s;
}

const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
export function toCsv(rows: unknown[][]): string {
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
