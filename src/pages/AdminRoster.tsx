import { useMemo, useState } from 'react';
import { api, fmtNum, fmtTime, kstToday, type District, type RosterSummary, type VoterKind } from '../apis';
import { useStore } from '../app/store';
import { usePolling } from '../hooks/usePolling';
import { downloadText, parseCsv, readTable, toCsv, toHM, toYMD } from '../data/sheet';

type Msg = { text: string; ok: boolean } | null;
interface UpRow { sid: string; name: string; district_id: string; dept: string }
const KIND_LABEL: Record<VoterKind, string> = { regular: '정회원(재학)', associate: '준회원(휴학)' };
const EXCLUDE = '__exclude__';

function guess(headers: string[], words: string[]) {
  const i = headers.findIndex((h) => words.some((w) => h.replace(/\s/g, '').includes(w)));
  return i >= 0 ? i : -1;
}

/** 브라우저에서 파일 → 지정한 4개 열만 1,000행씩 전송 (FR-80) */
async function uploadRows(kind: VoterKind, rows: UpRow[], onProgress: (done: number) => void) {
  const { upload_id } = await api<{ upload_id: string }>('/roster/upload/begin', { body: { kind } });
  try {
    for (let i = 0; i < rows.length; i += 1000) {
      await api('/roster/upload/chunk', { body: { upload_id, rows: rows.slice(i, i + 1000) } });
      onProgress(Math.min(rows.length, i + 1000));
    }
    return await api<{ count: number }>('/roster/upload/finish', { body: { upload_id, expected: rows.length } });
  } catch (e) {
    await api('/roster/upload/abort', { body: { upload_id } }).catch(() => undefined);
    throw e;
  }
}

function Uploader({ districts, disabled, onDone, setMsg }: { districts: District[]; disabled: boolean; onDone: () => void; setMsg: (m: Msg) => void }) {
  const [kind, setKind] = useState<VoterKind>('regular');
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<string[][] | null>(null);
  const [cols, setCols] = useState({ sid: -1, name: -1, district: -1, dept: -1 });
  const [dmap, setDmap] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const headers = table?.[0] ?? [];
  const body = useMemo(() => table?.slice(1) ?? [], [table]);
  const distinctDistricts = useMemo(() => (cols.district < 0 ? [] : [...new Set(body.map((r) => (r[cols.district] ?? '').trim()))].sort()), [body, cols.district]);

  const onFile = async (f: File | undefined) => {
    setMsg(null); setTable(null);
    if (!f) return;
    try {
      const t = await readTable(f);
      if (t.length < 2) throw new Error('헤더와 데이터가 있는 파일이 아닙니다.');
      setFileName(f.name); setTable(t);
      const h = t[0];
      const c = { sid: guess(h, ['학번']), name: guess(h, ['이름', '성명']), district: guess(h, ['단과', '대학', '소속']), dept: guess(h, ['학과', '전공', '학부']) };
      setCols(c);
      const vals = c.district < 0 ? [] : [...new Set(t.slice(1).map((r) => (r[c.district] ?? '').trim()))];
      setDmap(Object.fromEntries(vals.map((v) => [v, districts.find((d) => d.name === v)?.id ?? districts.find((d) => v && (d.name.includes(v) || v.includes(d.name)))?.id ?? ''])));
    } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
  };

  const check = useMemo(() => {
    if (!table || cols.sid < 0 || cols.name < 0 || cols.district < 0) return null;
    const errors: string[] = [];
    const rows: UpRow[] = [];
    const seen = new Map<string, number>();
    const lens = new Map<number, number>();
    let excluded = 0;
    body.forEach((r, i) => {
      const line = i + 2;
      const sid = (r[cols.sid] ?? '').replace(/[^0-9]/g, '');
      const name = (r[cols.name] ?? '').trim();
      const dv = (r[cols.district] ?? '').trim();
      const target = dmap[dv];
      if (target === EXCLUDE) { excluded++; return; }
      if (!sid || !name) { errors.push(`${line}행: 학번 또는 이름이 비어 있음`); return; }
      if (!target) { errors.push(`${line}행: 연결되지 않은 단과대학 "${dv}"`); return; }
      if (seen.has(sid)) { errors.push(`${line}행: 학번 ${sid} 중복 (${seen.get(sid)}행과 같음)`); return; }
      seen.set(sid, line);
      lens.set(sid.length, (lens.get(sid.length) ?? 0) + 1);
      rows.push({ sid, name, district_id: target, dept: cols.dept >= 0 ? (r[cols.dept] ?? '').trim() : '' });
    });
    const perDistrict = districts.map((d) => ({ name: d.name, n: rows.filter((x) => x.district_id === d.id).length })).filter((x) => x.n > 0);
    return { errors, rows, excluded, perDistrict, lens: [...lens.entries()].sort((a, b) => b[1] - a[1]) };
  }, [table, body, cols, dmap, districts]);

  const unmapped = distinctDistricts.filter((v) => !dmap[v]);
  const canUpload = !!check && check.errors.length === 0 && unmapped.length === 0 && check.rows.length > 0 && !progress;

  const start = async () => {
    if (!check) return;
    if (!window.confirm(`${KIND_LABEL[kind]} ${fmtNum(check.rows.length)}명을 올립니다. 기존 ${KIND_LABEL[kind]} 명부는 모두 교체됩니다. 계속할까요?`)) return;
    setMsg(null); setProgress({ done: 0, total: check.rows.length });
    try {
      const r = await uploadRows(kind, check.rows, (done) => setProgress({ done, total: check.rows.length }));
      setMsg({ text: `${KIND_LABEL[kind]} ${fmtNum(r.count)}명을 등록했습니다.`, ok: true });
      setTable(null); setFileName(''); onDone();
    } catch (e) { setMsg({ text: (e as Error).message, ok: false }); } finally { setProgress(null); }
  };

  const colSelect = (key: keyof typeof cols, label: string, optional = false) => (
    <div className="field" style={{ flex: '1 1 140px' }}>
      <label>{label}</label>
      <select className="input" value={cols[key]} onChange={(e) => setCols({ ...cols, [key]: Number(e.target.value) })}>
        <option value={-1}>{optional ? '(없음)' : '열 선택'}</option>
        {headers.map((h, i) => <option key={i} value={i}>{h || `${i + 1}열`}</option>)}
      </select>
    </div>
  );

  return (
    <div className="card stack">
      <h1>선거인명부 업로드</h1>
      <p className="muted small">파일은 이 브라우저 안에서만 읽고, 지정한 학번·이름·단과대학·학과 4개 열만 서버로 보냅니다. 서버는 이름·학과를 암호화하고 학번은 해시로만 저장합니다. 원본 파일은 어디에도 저장되지 않습니다.</p>
      <div className="row" style={{ gap: 8 }}>
        {(['regular', 'associate'] as VoterKind[]).map((k) => (
          <button key={k} className={`btn ${kind === k ? 'primary' : ''}`} onClick={() => setKind(k)} disabled={!!progress}>{KIND_LABEL[k]}</button>
        ))}
      </div>
      <input type="file" accept=".xlsx,.csv" disabled={disabled || !!progress} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
      {table && (
        <>
          <div className="small muted">{fileName} · 데이터 {fmtNum(body.length)}행 (헤더만 표시하고 개인정보 행은 보여 주지 않습니다)</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {colSelect('sid', '학번 열')}{colSelect('name', '이름 열')}{colSelect('district', '단과대학 열')}{colSelect('dept', '학과 열', true)}
          </div>
          {distinctDistricts.length > 0 && (
            <div className="stack">
              <h2>단과대학 값 연결</h2>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>파일의 값</th><th className="num">인원</th><th>선거구</th></tr></thead>
                  <tbody>
                    {distinctDistricts.map((v) => (
                      <tr key={v}>
                        <td>{v || '(빈 칸)'}</td>
                        <td className="num">{fmtNum(body.filter((r) => (r[cols.district] ?? '').trim() === v).length)}</td>
                        <td>
                          <select className="input" value={dmap[v] ?? ''} onChange={(e) => setDmap({ ...dmap, [v]: e.target.value })} style={{ borderColor: dmap[v] ? undefined : 'var(--danger)' }}>
                            <option value="">연결 안 됨</option>
                            {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                            <option value={EXCLUDE}>제외 (선거권 없음)</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {check && (
            <div className="stack">
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <span className="pill accent">등록 {fmtNum(check.rows.length)}명</span>
                {check.excluded > 0 && <span className="pill muted">제외 {fmtNum(check.excluded)}명</span>}
                {check.lens.length > 1 && <span className="pill warn">학번 길이 섞임: {check.lens.map(([l, n]) => `${l}자리 ${n}`).join(' · ')}</span>}
                {check.errors.length > 0 && <span className="pill danger">오류 {check.errors.length}건</span>}
              </div>
              {check.errors.length > 0 && (
                <div className="alert danger small">
                  {check.errors.slice(0, 20).map((e) => <div key={e}>{e}</div>)}
                  {check.errors.length > 20 && <div>외 {check.errors.length - 20}건 · 파일을 고친 뒤 다시 올리세요.</div>}
                </div>
              )}
              {check.perDistrict.length > 0 && <div className="small muted">{check.perDistrict.map((x) => `${x.name} ${fmtNum(x.n)}`).join(' · ')}</div>}
            </div>
          )}
          {progress && <div className="alert info">업로드 중… {fmtNum(progress.done)} / {fmtNum(progress.total)}</div>}
          <button className="btn primary" disabled={!canUpload} onClick={start}>{KIND_LABEL[kind]} {check ? fmtNum(check.rows.length) + '명 ' : ''}올리기</button>
        </>
      )}
    </div>
  );
}

const SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예경봉사부가복태목형피두감음빈동온호범좌팽승간상시갈단견당';
const GIVEN = '민서지현준우도윤하은수진예린시아건영호성재희유연채원승혜정태경나리선미주아인혁찬규';

/** 리허설용 가짜 명부 23,000명 (FR-84). 학번은 99로 시작 */
function fakeRows(districts: District[]) {
  const SAMPLE: Record<string, number> = { '건축대학': 373, '경영대학': 1412, '공과대학': 4750, '국제대학': 361, '문과대학': 1550, '부동산과학원': 420, '사범대학': 880, '사회과학대학': 1420, '상허교양대학': 1200, '생명과학대학': 1120, '수의과대학': 460, '예술디자인대학': 990, '융합과학기술원': 1180, '이과대학': 405 };
  const total = districts.reduce((a, d) => a + (SAMPLE[d.name] ?? 500), 0);
  let seed = 11; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const pick = (s: string) => s[Math.floor(rnd() * s.length)];
  const regular: UpRow[] = [], associate: UpRow[] = [];
  let n = 0;
  for (const d of districts) {
    const cnt = Math.round(((SAMPLE[d.name] ?? 500) / total) * 23000);
    for (let i = 0; i < cnt; i++) {
      const row = { sid: '99' + String(n++).padStart(7, '0'), name: pick(SURNAMES) + pick(GIVEN) + pick(GIVEN), district_id: d.id, dept: `${d.name} 가상학과` };
      (rnd() < 0.05 ? associate : regular).push(row);
    }
  }
  return { regular, associate };
}

export default function AdminRoster() {
  const { config, refreshConfig } = useStore();
  const { data: sum, reload } = usePolling(() => api<RosterSummary>('/roster/summary'), 30000, []);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState({ sid: '', name: '', dept: '', district_id: '', kind: 'regular' as VoterKind, reason: '' });
  const [edit, setEdit] = useState({ sid: '', kind: '', district_id: '', reason: '' });
  const [cancelSid, setCancelSid] = useState({ sid: '', reason: '' });
  const [resetText, setResetText] = useState('');
  const [restoreText, setRestoreText] = useState('');
  const [restoreFile, setRestoreFile] = useState<{ windows: unknown[]; events: unknown[] } | null>(null);
  const [sheetDate, setSheetDate] = useState(kstToday());
  const [sheetRows, setSheetRows] = useState<Record<string, string>[] | null>(null);
  const [sheetPreview, setSheetPreview] = useState<{ index: number; sid: string; station: string | null; at: string | null; status: string }[] | null>(null);
  const [ret, setRet] = useState<{ on: string; days: string } | null>(null);
  const [purgeText, setPurgeText] = useState('');
  const [purged, setPurged] = useState(false);

  if (!config || !sum) return <main><p className="muted center">불러오는 중…</p></main>;
  const districts = config.districts;
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); await Promise.all([reload(), refreshConfig()]); if (ok) setMsg({ text: ok, ok: true }); }
    catch (e) { setMsg({ text: (e as Error).message, ok: false }); } finally { setBusy(false); }
  };
  const c = (did: string, kind: VoterKind, f: 'total' | 'voted') => Number(sum.counts.find((x) => x.district_id === did && x.kind === kind)?.[f] ?? 0);
  const totals = { regular: districts.reduce((a, d) => a + c(d.id, 'regular', 'total'), 0), associate: districts.reduce((a, d) => a + c(d.id, 'associate', 'total'), 0) };
  const rosterReady = totals.regular + totals.associate > 0;
  const retention = ret ?? { on: sum.result_announced_on ?? '', days: String(sum.retention_days) };
  const STATUS_LABEL: Record<string, string> = { ok: '반영 가능', dup_in_sheet: '시트 안 중복', voted: '이미 투표', not_found: '명부에 없음', other_district: '다른 선거구', invalid: '형식 오류' };

  const makeFake = () => {
    if (!window.confirm('리허설용 가짜 명부 23,000명(학번 99로 시작)을 만들어 올립니다. 기존 명부는 교체됩니다. 계속할까요?')) return;
    run(async () => {
      const f = fakeRows(districts);
      await uploadRows('regular', f.regular, (d) => setMsg({ text: `가짜 정회원 업로드 중 ${fmtNum(d)} / ${fmtNum(f.regular.length)}`, ok: true }));
      await uploadRows('associate', f.associate, () => undefined);
    }, '가짜 명부 23,000명을 등록했습니다.');
  };

  const onRestoreFile = async (file?: File) => {
    if (!file) return;
    try {
      const rows = parseCsv((await file.text()).replace(/^﻿/, ''));
      const head = rows[0] ?? [];
      const di = head.indexOf('데이터'), ki = head.indexOf('구분');
      if (di < 0 || ki < 0) throw new Error('체크 기록 백업 파일이 아닙니다.');
      const windows = rows.slice(1).filter((r) => r[ki] === '마감').map((r) => JSON.parse(r[di]));
      const events = rows.slice(1).filter((r) => r[ki] === '체크').map((r) => JSON.parse(r[di]));
      setRestoreFile({ windows, events });
    } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
  };
  const doRestore = () => run(async () => {
    if (!restoreFile) return;
    const { windows, events } = restoreFile;
    let first = true;
    for (let i = 0; i < windows.length; i += 1000) { await api('/roster/restore/chunk', { body: { first, windows: windows.slice(i, i + 1000), events: [] } }); first = false; }
    for (let i = 0; i < events.length; i += 1000) { await api('/roster/restore/chunk', { body: { first, windows: [], events: events.slice(i, i + 1000) } }); first = false; }
    const r = await api<{ voted: number }>('/roster/restore/finish', { body: { confirm: '복원' } });
    setRestoreFile(null); setRestoreText('');
    setMsg({ text: `복원했습니다. 투표 상태 ${fmtNum(r.voted)}명`, ok: true });
  });

  const onSheetFile = async (file?: File) => {
    if (!file) return;
    setSheetPreview(null);
    try {
      const t = await readTable(file);
      const h = t[0] ?? [];
      const idx = { sid: guess(h, ['학번']), time: guess(h, ['시각', '시간']), station: guess(h, ['투표소']), recorder: guess(h, ['기록자', '위원']), date: guess(h, ['날짜', '일자']) };
      if (idx.sid < 0 || idx.time < 0 || idx.station < 0) throw new Error('학번·시각·투표소 열이 있어야 합니다. 시스템에서 받은 양식을 쓰세요.');
      const rows = t.slice(1).map((r) => ({
        sid: r[idx.sid] ?? '', time: toHM(r[idx.time] ?? ''), station: r[idx.station] ?? '', recorder: idx.recorder >= 0 ? r[idx.recorder] ?? '' : '',
        date: idx.date >= 0 && r[idx.date] ? toYMD(r[idx.date]) : sheetDate,
      }));
      setSheetRows(rows);
      const p = await api<{ rows: typeof sheetPreview }>('/roster/sheet/preview', { body: { rows } });
      setSheetPreview(p.rows);
    } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
  };

  return (
    <main className="stack">
      {(msg || busy) && (
        <div className={`alert toast ${busy && !msg ? 'info' : msg?.ok ? 'good' : 'danger'}`} role="status" onClick={() => setMsg(null)}>{msg?.text ?? '처리 중…'}</div>
      )}
      {!sum.keys_configured && <div className="alert warn small">명부 암호화 키(VOTER_ENC_KEY, VOTER_HMAC_KEY)가 이 서버 환경변수에 없습니다. 로컬 개발용 키로 동작 중이며, 배포 환경에서는 키 없이 명부 기능이 동작하지 않습니다.</div>}
      {sum.purged_at && <div className="alert info">선거인명부가 {fmtTime(sum.purged_at)}에 파기되었습니다.</div>}

      <div className="card stack">
        <div className="row between">
          <h1>선거인명부 현황</h1>
          <div className="row" style={{ gap: 6 }}>
            <span className="pill accent">정회원 {fmtNum(totals.regular)}</span>
            <span className="pill warn">준회원 {fmtNum(totals.associate)}</span>
            <span className="pill muted">체크 기록 {fmtNum(sum.event_count)}건</span>
          </div>
        </div>
        {sum.uploading && (
          <div className="alert warn row between">
            <span>{KIND_LABEL[sum.uploading.kind]} 업로드가 끝나지 않았습니다 ({sum.uploading.by}, {fmtTime(sum.uploading.at)}). 끝날 때까지 명부 조회가 멈춥니다.</span>
            <button className="btn sm" onClick={() => run(() => api('/roster/upload/abort', { body: {} }), '중단된 업로드를 정리했습니다.')}>정리</button>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead><tr><th>선거구</th><th className="num">정회원(재학)</th><th className="num">준회원(휴학)</th><th className="num">투표(정)</th><th className="num">편입 휴학생</th><th className="num">유권자</th></tr></thead>
            <tbody>
              {districts.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 600 }}>{d.name}</td>
                  <td className="num">{fmtNum(c(d.id, 'regular', 'total'))}</td>
                  <td className="num">{fmtNum(c(d.id, 'associate', 'total'))}</td>
                  <td className="num">{fmtNum(c(d.id, 'regular', 'voted'))}</td>
                  <td className="num">{fmtNum(c(d.id, 'associate', 'voted'))}</td>
                  <td className="num"><span className="muted small">{fmtNum(c(d.id, 'regular', 'total'))} + {fmtNum(c(d.id, 'associate', 'voted'))} = </span><strong>{fmtNum(c(d.id, 'regular', 'total') + c(d.id, 'associate', 'voted'))}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">투표 숫자는 실시간 체크 기준입니다 (대조 전 포함). 공지·현황판 투표율은 꼬리표 대조를 마친 값만 씁니다. 기본 유권자수 = 정회원 수로 자동 계산됩니다.</p>
      </div>

      <Uploader districts={districts} disabled={busy || sum.event_count > 0 || !!sum.purged_at} onDone={() => { reload(); refreshConfig(); }} setMsg={setMsg} />
      {sum.event_count > 0 && <div className="alert info small">체크 기록이 있어 명부를 교체할 수 없습니다. 리허설 후라면 아래 "체크 기록 초기화"를 먼저 하세요.</div>}

      <div className="grid cols-2">
        <div className="card stack">
          <h1>개별 추가</h1>
          <p className="muted small">학교 명부 누락 등 증빙을 확인한 경우에만 총관리자가 추가합니다. 현장 위원은 추가할 수 없습니다.</p>
          <div className="form-row">
            <input className="input" inputMode="numeric" placeholder="학번" value={add.sid} onChange={(e) => setAdd({ ...add, sid: e.target.value })} />
            <input className="input" placeholder="이름" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
          </div>
          <div className="form-row">
            <input className="input" placeholder="학과" value={add.dept} onChange={(e) => setAdd({ ...add, dept: e.target.value })} />
            <select className="input" value={add.district_id} onChange={(e) => setAdd({ ...add, district_id: e.target.value })}>
              <option value="">선거구</option>{districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select className="input" value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value as VoterKind })}>
              <option value="regular">정회원</option><option value="associate">준회원</option>
            </select>
          </div>
          <input className="input" placeholder="사유 (증빙)" value={add.reason} onChange={(e) => setAdd({ ...add, reason: e.target.value })} />
          <button className="btn" disabled={busy || !rosterReady || !add.sid || !add.name || !add.district_id || !add.reason} onClick={() => run(() => api('/roster/voters', { body: add }).then(() => setAdd({ sid: '', name: '', dept: '', district_id: '', kind: 'regular', reason: '' })), '명부에 추가했습니다.')}>추가</button>
        </div>
        <div className="card stack">
          <h1>개별 정정</h1>
          <p className="muted small">학번으로 학적(정/준) 또는 선거구를 바꿉니다. 이미 투표한 선거인은 바꿀 수 없습니다.</p>
          <input className="input" inputMode="numeric" placeholder="학번" value={edit.sid} onChange={(e) => setEdit({ ...edit, sid: e.target.value })} />
          <div className="form-row">
            <select className="input" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
              <option value="">학적 그대로</option><option value="regular">정회원으로</option><option value="associate">준회원으로</option>
            </select>
            <select className="input" value={edit.district_id} onChange={(e) => setEdit({ ...edit, district_id: e.target.value })}>
              <option value="">선거구 그대로</option>{districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <input className="input" placeholder="사유" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
          <button className="btn" disabled={busy || !edit.sid || !edit.reason || (!edit.kind && !edit.district_id)} onClick={() => run(() => api('/roster/voters', { method: 'PUT', body: { sid: edit.sid, kind: edit.kind || undefined, district_id: edit.district_id || undefined, reason: edit.reason } }).then(() => setEdit({ sid: '', kind: '', district_id: '', reason: '' })), '정정했습니다.')}>정정</button>
        </div>
      </div>

      <div className="card stack">
        <h1>체크 취소 (총관리자)</h1>
        <p className="muted small">5분이 지난 체크나 다른 위원의 체크를 취소합니다. 대조가 끝나지 않은 구간의 체크만 취소할 수 있고, 대조가 끝난 구간은 대조 현황에서 조정으로 처리합니다.</p>
        <div className="form-row">
          <input className="input" inputMode="numeric" placeholder="학번" value={cancelSid.sid} onChange={(e) => setCancelSid({ ...cancelSid, sid: e.target.value })} />
          <input className="input wide" placeholder="사유" value={cancelSid.reason} onChange={(e) => setCancelSid({ ...cancelSid, reason: e.target.value })} />
          <button className="btn" disabled={busy || !cancelSid.sid || !cancelSid.reason} onClick={() => run(() => api('/roster/cancel-by-sid', { body: cancelSid }).then(() => setCancelSid({ sid: '', reason: '' })), '체크를 취소했습니다.')}>취소</button>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card stack">
          <h1>체크 기록 백업</h1>
          <p className="muted small">학번 해시·투표소·시각·마감 기록만 담고 이름·학과는 없습니다. 꼬리표 마감 때마다 받아 두세요.</p>
          <div className="row between"><span className="muted">마지막 백업</span><strong>{sum.last_backup_at ? fmtTime(sum.last_backup_at) : '없음'}</strong></div>
          {sum.closes_since_backup > 0 && <div className="alert warn small">마지막 백업 이후 대조가 끝난 마감 {sum.closes_since_backup}건</div>}
          <a className="btn primary" href="/api/roster/backup.csv" onClick={() => setTimeout(reload, 1500)}>백업 CSV 내려받기</a>
          <h2 style={{ marginTop: 8 }}>복원</h2>
          <p className="muted small">체크 기록이 비어 있을 때(DB 손실 또는 체크 기록 초기화 직후)만 됩니다. 명부를 다시 올린 뒤 같은 암호화 키로 복원하세요.</p>
          <input type="file" accept=".csv" onChange={(e) => { onRestoreFile(e.target.files?.[0]); e.target.value = ''; }} />
          {restoreFile && (
            <div className="row">
              <span className="small">마감 {restoreFile.windows.length}건 · 체크 {restoreFile.events.length}건</span>
              <input className="input" style={{ maxWidth: 140 }} placeholder="복원 이라고 입력" value={restoreText} onChange={(e) => setRestoreText(e.target.value)} />
              <button className="btn" disabled={busy || restoreText.trim() !== '복원'} onClick={doRestore}>복원 실행</button>
            </div>
          )}
        </div>

        <div className="card stack">
          <h1>장애 기록 시트</h1>
          <p className="muted small">시스템이 끊기면 위원은 학생증의 학번을 빈 시트에 적고 용지를 줍니다. <strong>시트에 명부를 넣지 마세요.</strong> 복구 후 시트를 CSV로 내려받아 여기에 올리면 중복·미등재를 걸러 반영하고, 반영분은 다음 꼬리표 마감에서 대조됩니다.</p>
          <button className="btn" onClick={() => downloadText('장애기록시트_양식.csv', toCsv([['학번', '시각', '투표소', '기록자'], ['', '13:05', config.stations[0]?.name ?? '', '']]))}>빈 양식 CSV 내려받기</button>
          <div className="form-row">
            <div className="field" style={{ flex: '0 0 auto' }}><label>날짜 (시트에 날짜 열이 없을 때)</label><input className="input" type="date" value={sheetDate} onChange={(e) => setSheetDate(e.target.value)} /></div>
          </div>
          <input type="file" accept=".csv,.xlsx" disabled={!rosterReady} onChange={(e) => { onSheetFile(e.target.files?.[0]); e.target.value = ''; }} />
          {sheetPreview && (
            <div className="stack">
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {Object.entries(STATUS_LABEL).map(([k, label]) => {
                  const n = sheetPreview.filter((r) => r.status === k).length;
                  return n ? <span key={k} className={`pill ${k === 'ok' ? 'good' : 'warn'}`}>{label} {n}</span> : null;
                })}
              </div>
              {sheetPreview.filter((r) => r.status !== 'ok').length > 0 && (
                <div className="table-wrap" style={{ maxHeight: 200, overflow: 'auto' }}>
                  <table><tbody>{sheetPreview.filter((r) => r.status !== 'ok').map((r) => <tr key={r.index}><td>{r.index + 2}행</td><td className="mono">{r.sid}</td><td>{r.station ?? '?'}</td><td>{STATUS_LABEL[r.status]}</td></tr>)}</tbody></table>
                </div>
              )}
              <button className="btn primary" disabled={busy || !sheetPreview.some((r) => r.status === 'ok')} onClick={() => run(async () => {
                const r = await api<{ applied: number; failed: number }>('/roster/sheet/apply', { body: { rows: sheetRows } });
                setSheetPreview(null); setSheetRows(null);
                setMsg({ text: `장애 시트 ${r.applied}명을 반영했습니다.${r.failed ? ` (그사이 이미 투표 ${r.failed}명)` : ''}`, ok: true });
              })}>정상 {sheetPreview.filter((r) => r.status === 'ok').length}명 반영</button>
            </div>
          )}
        </div>
      </div>

      <div className="card stack">
        <h1>리허설용</h1>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy || sum.event_count > 0 || !!sum.purged_at} onClick={makeFake}>가짜 명부 23,000명 만들기</button>
        </div>
        <h2 style={{ color: 'var(--danger)', marginTop: 8 }}>체크 기록 초기화</h2>
        <p className="muted small">모든 체크·마감·조정 기록과 그로 생긴 자동 입력값을 지우고 투표 상태를 해제합니다. 명부·근무표·접근 로그는 남습니다. 되돌릴 수 없으니 먼저 백업하세요.</p>
        <div className="row">
          <input className="input" style={{ maxWidth: 220 }} placeholder="체크기록초기화 라고 입력" value={resetText} onChange={(e) => setResetText(e.target.value)} />
          <button className="btn danger" disabled={busy || resetText.trim() !== '체크기록초기화'} onClick={() => run(() => api('/roster/reset-checks', { body: { confirm: '체크기록초기화' } }).then(() => setResetText('')), '체크 기록을 초기화했습니다.')}>초기화 실행</button>
        </div>
      </div>

      <div className="card stack">
        <h1 style={{ color: 'var(--danger)' }}>보유기간과 파기</h1>
        <p className="muted small">결과 공고일 + 보유일수(이의신청 기간)가 지나야 파기할 수 있습니다. 파기하면 명부·체크 기록이 삭제되고, 접근 로그의 학번 정보도 지워집니다. 투표율 집계 숫자와 변경 로그는 남습니다.</p>
        <div className="form-row">
          <div className="field" style={{ flex: '0 0 auto' }}><label>결과 공고일</label><input className="input" type="date" value={retention.on} onChange={(e) => setRet({ ...retention, on: e.target.value })} /></div>
          <div className="field" style={{ flex: '0 0 120px' }}><label>보유일수</label><input className="input" inputMode="numeric" value={retention.days} onChange={(e) => setRet({ ...retention, days: e.target.value.replace(/[^0-9]/g, '') })} /></div>
          <button className="btn" disabled={busy || !ret} onClick={() => run(() => api('/roster/retention', { method: 'PUT', body: { result_announced_on: retention.on || null, retention_days: Number(retention.days || 7) } }).then(() => setRet(null)), '보유기간을 저장했습니다.')}>저장</button>
        </div>
        <div className="muted small">{sum.purge_available_from ? `${sum.purge_available_from}부터 파기할 수 있습니다.` : '결과 공고일을 입력하면 파기 가능일이 계산됩니다.'}</div>
        <div className="row">
          <input className="input" style={{ maxWidth: 200 }} placeholder="명부파기 라고 입력" value={purgeText} onChange={(e) => setPurgeText(e.target.value)} disabled={!sum.purge_available} />
          <button className="btn danger" disabled={busy || !sum.purge_available || purgeText.trim() !== '명부파기'} onClick={() => run(() => api('/roster/purge', { body: { confirm: '명부파기' } }).then(() => { setPurged(true); setPurgeText(''); }), '선거인명부를 파기했습니다.')}>파기 실행</button>
        </div>
        {(purged || sum.purged_at) && (
          <div className="alert warn small">
            <strong>파기 후 직접 할 일</strong>
            <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>Vercel 환경변수에서 VOTER_ENC_KEY, VOTER_HMAC_KEY 삭제</li>
              <li>내려받은 체크 기록 백업 CSV 삭제</li>
              <li>장애 기록 구글 시트 삭제 (휴지통 비우기 포함)</li>
              <li>원본 선거인명부 파일(정회원·준회원) 삭제</li>
              <li>위원장·간사가 보관한 암호화 키 사본 폐기</li>
            </ol>
          </div>
        )}
      </div>
    </main>
  );
}
