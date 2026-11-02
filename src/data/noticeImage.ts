import { fmtNum, fmtPct, noticeDate, type TallyPoint } from '../apis';

/** 디자인 원본(1080×1350) 좌표를 그대로 쓰고, 출력은 2배 해상도. */
const W = 1080, H = 1350, SCALE = 2;
const FONT = '"Pretendard Variable", Pretendard, sans-serif';
const INK = '#040000', BRAND = '#094152', RED = '#e7211a';
const BAR = { x: 123.56, w: 799, h: 28.2, y0: 313.64, step: 185.21 };
const ROWS_PER_PAGE = [5, 5, 4];

let bgPromise: Promise<HTMLImageElement> | null = null;
function loadBg(): Promise<HTMLImageElement> {
  if (!bgPromise) {
    bgPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('배경 이미지를 불러오지 못했습니다.'));
      img.src = '/notice-bg.svg';
    });
  }
  return bgPromise;
}

async function ensureFonts(texts: string[]) {
  if (!('fonts' in document)) return;
  const sample = texts.join('');
  await Promise.all([400, 500, 600, 700].map((w) => document.fonts.load(`${w} 40px ${FONT}`, sample)));
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, weight: number, opts: { align?: CanvasTextAlign; color?: string; spacing?: number } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = opts.color ?? INK;
  ctx.textAlign = opts.align ?? 'left';
  ctx.textBaseline = 'alphabetic';
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  c.letterSpacing = opts.spacing ? `${opts.spacing}px` : '0px';
  ctx.fillText(s, x, y);
  c.letterSpacing = '0px';
}

function newCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE; canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SCALE, SCALE);
  return { canvas, ctx };
}

function header(ctx: CanvasRenderingContext2D, bg: HTMLImageElement, title: string, dateLine: string, titleY: number, dateY: number) {
  ctx.drawImage(bg, 0, 0, W, H);
  text(ctx, title, W / 2, titleY, 40, 500, { align: 'center' });
  text(ctx, dateLine, W / 2, dateY, 38, 600, { align: 'center' });
  // 하단 "건 / 국 / 대 / ..." 띄어쓰기 없이 자간으로
  text(ctx, '건/국/대/학/교/중/앙/선/거/관/리/위/원/회', W / 2, 1249.13, 35, 500, { align: 'center', spacing: 35 * 0.3 });
}

export interface NoticeImages { total: HTMLCanvasElement; pages: HTMLCanvasElement[] }

export async function renderNoticeImages(electionName: string, point: TallyPoint, thresholdPct: number): Promise<NoticeImages> {
  const title = `${electionName} 투표율`;
  const dateLine = noticeDate(point.date, point.time);
  const districts = point.districts;
  await ensureFonts([title, dateLine, '총 투표율 투표수 / 유권자 수 명 % 0123456789,.()', ...districts.map((d) => d.name)]);
  const bg = await loadBg();

  // 1) 총 투표율 카드
  const total = newCanvas();
  header(total.ctx, bg, title, dateLine, 216.03, 268.23);
  text(total.ctx, '총 투표율', W / 2, 522.87, 44.02, 400, { align: 'center', color: BRAND, spacing: 0.44 });
  text(total.ctx, fmtPct(point.total.pct), W / 2, 712.82, 200, 700, { align: 'center' });
  text(total.ctx, '투표수 / 유권자 수', W / 2, 798.15, 26.44, 500, { align: 'center', color: BRAND, spacing: 0.53 });
  text(total.ctx, `${fmtNum(point.total.cumulative)}명 / ${fmtNum(point.total.voters)}명`, W / 2, 847.39, 44.02, 500, { align: 'center', spacing: 0.44 });

  // 2) 선거구 막대 카드 (5 / 5 / 4)
  const pages: HTMLCanvasElement[] = [];
  let idx = 0;
  for (const count of ROWS_PER_PAGE) {
    const rows = districts.slice(idx, idx + count);
    idx += count;
    if (rows.length === 0) break;
    const { canvas, ctx } = newCanvas();
    header(ctx, bg, title, dateLine, 128.59, 180.79);
    rows.forEach((d, i) => {
      const y = BAR.y0 + i * BAR.step;
      text(ctx, d.name, 123.07, y - 32.72, 30.85, 600);
      ctx.fillStyle = BRAND;
      ctx.fillRect(BAR.x, y, BAR.w * Math.min(1, d.pct / 100), BAR.h);
      ctx.strokeStyle = INK; ctx.lineWidth = 2;
      ctx.strokeRect(BAR.x, y, BAR.w, BAR.h);
      const mx = BAR.x + BAR.w * (thresholdPct / 100);
      ctx.strokeStyle = RED; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mx, y - 1.1); ctx.lineTo(mx, y + BAR.h + 1.1); ctx.stroke();
      text(ctx, `${fmtNum(d.cumulative)}명/${fmtNum(d.voters)}명 (${fmtPct(d.pct)})`, 123.07, y + 74.02, 22.62, 500, { spacing: 0.3 });
    });
    pages.push(canvas);
  }
  return { total: total.canvas, pages };
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 변환 실패'))), 'image/png'));
}

export async function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const imageFilename = (point: { date: string; time: string }, n: number) =>
  `투표율_${point.date.slice(5)}_${point.time.replace(':', '-')}_${n}.png`;
