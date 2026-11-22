import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  fmtHM,
  fmtNum,
  type LookupResult,
  type RosterMe,
  type StationStatus,
} from "../apis";
import { useStore } from "../app/store";
import Pledge, { OperatorForm } from "../components/Pledge";
import Sheet from "../components/Sheet";
import {
  IssueForm,
} from "../components/DeskTools";

const RESULT_TTL_MS = 30_000;
const OWN_CANCEL_MS = 5 * 60_000;

type Done = { isLeave: boolean; order: number; missed: boolean };

/** S-09 명부 확인 + S-10 꼬리표 마감 (휴대폰) */
export default function RosterCheck() {
  const { config, me, refreshMe } = useStore();
  const [rm, setRm] = useState<RosterMe | null>(null);
  const [adminStation, setAdminStation] = useState("");
  const [status, setStatus] = useState<StationStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sid, setSid] = useState("");
  const [result, setResult] = useState<(LookupResult & { sid: string }) | null>(
    null,
  );
  const [idChecked, setIdChecked] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [busy, setBusy] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [adminDesk, setAdminDesk] = useState("");
  const [issueOpen, setIssueOpen] = useState(false);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [missedMode, setMissedMode] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [operatorOpen, setOperatorOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isAdmin = me?.role === "admin";
  /** 투표소를 직접 고르는 계정: 총관리자와 선관위원 (FR-117) */
  const canPick = me?.role === "admin" || me?.role === "member";
  const isStation = me?.role === "station";
  const stationId = canPick ? adminStation : (rm?.station?.id ?? "");
  const operator = rm?.device?.operator_name ?? null;
  // 명부를 쓸 준비: 총관리자는 계정 서약, 투표소 기기는 담당자 서약 (FR-94)
  const ready = canPick ? !!rm?.pledged_at : isStation ? !!rm?.device?.operator_pledged && !!rm?.device?.desk_id : false;

  const loadMe = useCallback(async () => {
    try {
      setRm(await api<RosterMe>("/roster/me"));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  const loadStatus = useCallback(async () => {
    if (!stationId || !ready) {
      setStatus(null);
      return;
    }
    try {
      setStatus(
        await api<StationStatus>(
          `/roster/station?station_id=${encodeURIComponent(stationId)}${canPick && adminDesk ? `&desk_id=${encodeURIComponent(adminDesk)}` : ""}`,
        ),
      );
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
      setStatus(null);
    }
  }, [stationId, ready, canPick, adminDesk]);

  useEffect(() => {
    loadMe();
  }, [loadMe]);
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);
  // 조회 결과는 30초 뒤 지운다 (15.3)
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => {
      setResult(null);
      setIdChecked(false);
    }, RESULT_TTL_MS);
    return () => clearTimeout(t);
  }, [result]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => {
      setDone(null);
      inputRef.current?.focus();
    }, 3000);
    return () => clearTimeout(t);
  }, [done]);
  useEffect(() => {
    if (!status?.reconciling) setMissedMode(false);
  }, [status?.reconciling]);

  if (!config || !rm)
    return (
      <main className="narrow">
        <p className="muted center">불러오는 중…</p>
      </main>
    );
  if (rm.purged)
    return (
      <main className="narrow">
        <div className="alert info">선거인명부가 파기되었습니다.</div>
      </main>
    );
  const afterOperator = async () => {
    setOperatorOpen(false);
    setResult(null);
    await Promise.all([loadMe(), refreshMe()]);
  };
  if (isStation && !ready)
    return (
      <main className="narrow stack">
        <div className="card stack">
          <h1>담당자 등록</h1>
          {rm.station && (
            <div className="muted">
              {rm.station.name} 투표소 · {rm.device?.device_no}번 기기
            </div>
          )}
          <OperatorForm currentDeskId={rm.device?.desk_id} onDone={afterOperator} />
        </div>
      </main>
    );
  if (canPick && !rm.pledged_at)
    return (
      <main className="narrow stack">
        <Pledge onDone={loadMe} />
      </main>
    );

  const station = config.stations.find((s) => s.id === stationId);
  const district = station
    ? config.districts.find((d) => d.id === station.district_id)
    : null;

  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    const q = sid.replace(/[^0-9]/g, "");
    if (!q) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    setIdChecked(false);
    const t0 = performance.now();
    try {
      const r = await api<LookupResult>("/roster/lookup", {
        body: { sid: q, station_id: stationId },
      });
      setElapsed(performance.now() - t0);
      setResult({ ...r, sid: q });
      setSid((cur) => (cur.replace(/[^0-9]/g, "") === q ? "" : cur));
    } catch (e2) {
      setErr((e2 as Error).message);
      setResult(null);
      if (e2 instanceof ApiError && e2.code === "operator_required") loadMe();
    } finally {
      setBusy(false);
    }
  };

  const issue = async () => {
    if (!result || result.result !== "ok") return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ is_leave: boolean; open_count: number; total_count: number }>(
        "/roster/issue",
        {
          body: {
            voter_id: result.voter_id,
            station_id: stationId,
            desk_id: canPick ? adminDesk || undefined : undefined,
            id_checked: true,
            missed_window_id: missedMode ? status?.reconciling?.id : undefined,
          },
        },
      );
      setDone({ isLeave: r.is_leave, order: r.total_count, missed: missedMode });
      setResult(null);
      setIdChecked(false);
      await loadStatus();
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === "already_voted") {
        setResult({
          ...result,
          result: "voted",
          voted_at: e2.extra?.voted_at,
          voted_station_name: e2.extra?.voted_station_name,
        } as LookupResult & { sid: string });
      } else setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    const reason = window.prompt(
      "취소 사유를 적어 주세요 (예: 다른 학생을 체크함)",
    );
    if (!reason?.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/roster/cancel", { body: { event_id: id, reason } });
      await loadStatus();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 마감 전 확인: 투표소 기기는 "지금 담당자가 ○○○ 맞나요?" (FR-89)
  const askClose = () => {
    if (isStation) {
      setConfirmClose(true);
      return;
    }
    if (
      window.confirm(
        "지금 시각으로 꼬리표를 마감할까요? 이후 체크는 다음 구간으로 들어갑니다.",
      )
    )
      beginClose();
  };
  const beginClose = async () => {
    setConfirmClose(false);
    setBusy(true);
    setErr(null);
    try {
      await api("/roster/close", {
        body: { station_id: stationId, operator_name: operator, desk_id: canPick ? adminDesk || undefined : undefined },
      });
      await loadStatus();
      setTagInput("");
      setMismatch(null);
      setCloseOpen(true);
    } catch (e2) {
      setErr((e2 as Error).message);
      if (e2 instanceof ApiError && e2.code === "operator_changed") loadMe();
    } finally {
      setBusy(false);
    }
  };
  const submitTags = async () => {
    if (!status?.reconciling) return;
    setBusy(true);
    setMismatch(null);
    try {
      await api(`/roster/close/${status.reconciling.id}/submit`, {
        body: { total: Number(tagInput) },
      });
      setCloseOpen(false);
      setMissedMode(false);
      await loadStatus();
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === "mismatch")
        setMismatch(e2.message);
      else setMismatch((e2 as Error).message);
      await loadStatus();
    } finally {
      setBusy(false);
    }
  };

  const rec = status?.reconciling ?? null;
  const deskArg = canPick ? adminDesk || undefined : undefined;
  const now = Date.now();

  return (
    <main className="narrow stack">
      {/* 근무·투표소 */}
      <div className="card stack">
        <div className="row between">
          <h1>명부 확인</h1>
          <button
            className="btn sm ghost"
            onClick={() => {
              loadMe();
              loadStatus();
            }}
          >
            새로고침
          </button>
        </div>
        {canPick ? (
          <div className="field">
            <label htmlFor="adm-st">투표소 ({isAdmin ? "총관리자" : "선관위원"})</label>
            <select
              id="adm-st"
              className="input"
              value={adminStation}
              onChange={(e) => {
                setAdminStation(e.target.value);
                setAdminDesk("");
                setResult(null);
              }}
            >
              <option value="">투표소 선택</option>
              {config.stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {status && (
              <>
                <label htmlFor="adm-desk" style={{ marginTop: 8 }}>창구</label>
                <select
                  id="adm-desk"
                  className="input"
                  value={adminDesk}
                  onChange={(e) => {
                    setAdminDesk(e.target.value);
                    setResult(null);
                  }}
                >
                  <option value="">창구 미지정</option>
                  {status.desks.filter((d) => !d.is_unassigned).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        ) : (
          rm.station && (
            <div
              className="row between"
              style={{
                gap: 8,
                padding: "10px 12px",
                background: "var(--surface-2)",
                borderRadius: 10,
              }}
            >
              <div>
                <div style={{ fontWeight: 700 }}>
                  {rm.desk?.name} 창구 · 담당자: {operator} ·{" "}
                  {fmtHM(rm.device?.operator_since ?? null)}부터
                </div>
                <div className="small muted">
                  {rm.device?.device_no}번 기기 · 로그인{" "}
                  {fmtHM(rm.device?.created_at ?? null)} ·{" "}
                  {fmtHM(rm.device?.expires_at ?? null)}까지
                </div>
              </div>
              <button
                className="btn sm"
                onClick={() => setOperatorOpen(true)}
              >
                담당자 변경
              </button>
            </div>
          )
        )}
        {rm.hours && !rm.hours.allowed && (
          <div className="alert warn">{rm.hours.message}</div>
        )}
        {!rm.roster_ready && (
          <div className="alert warn">
            {rm.uploading
              ? "선거인명부 업로드가 진행 중입니다."
              : "선거인명부가 아직 등록되지 않았습니다."}
          </div>
        )}
        {station && status && (
          <>
            <div className="row between" style={{ alignItems: "flex-end" }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {station.name} · {status.desk.name}
                </div>
                <div className="small muted">
                  {district && district.name !== station.name
                    ? `${district.name} 선거구 · `
                    : ""}
                  마지막 대조{" "}
                  {status.last_window
                    ? fmtHM(status.last_window.boundary_at)
                    : "없음"}
                </div>
              </div>
              <div className="right" style={{ textAlign: "right" }}>
                <div className="small muted">이 창구의 누적 투표</div>
                <div style={{ fontSize: 24, fontWeight: 800 }}>
                  {fmtNum(status.total_count)}명
                </div>
                <div className="small muted">
                  마지막 마감 뒤 {fmtNum(status.open_count)}명
                  {status.total_leave > 0 ? ` · 준회원 ${status.total_leave}` : ""}
                </div>
              </div>
            </div>
            {rec ? (
              <div className="alert warn row between" style={{ gap: 8 }}>
                <span>
                  대조 중 · {fmtHM(rec.boundary_at)} 마감분
                </span>
                <button
                  className="btn sm primary"
                  onClick={() => {
                    setTagInput("");
                    setMismatch(null);
                    setCloseOpen(true);
                  }}
                >
                  꼬리표 수 입력
                </button>
              </div>
            ) : (
              <button
                className="btn block"
                disabled={busy || !rm.roster_ready}
                onClick={askClose}
              >
                꼬리표 마감 (매 정각 / 근무자 교대 직전)
              </button>
            )}
            <div className="row between">
              <span className="small muted">
                {status.issue_count > 0 ? `신고한 이슈 ${status.issue_count}건` : "꼬리표를 잃어버렸거나 용지를 폐기했으면 신고하세요."}
              </span>
              <button className="btn sm ghost" onClick={() => setIssueOpen(true)}>
                이슈 신고
              </button>
            </div>
          </>
        )}
      </div>

      {err && (
        <div className="alert danger" role="alert">
          {err}
        </div>
      )}

      {/* 학번 조회 */}
      {station && status && rm.roster_ready && (
        <div className="card stack">
          {missedMode && rec && (
            <div className="alert info">
              누락분 추가 모드 · 체크하면 {fmtHM(rec.boundary_at)} 마감 구간에
              들어갑니다.{" "}
              <button
                className="btn sm ghost"
                onClick={() => setMissedMode(false)}
              >
                끄기
              </button>
            </div>
          )}
          <form className="row" style={{ gap: 8 }} onSubmit={lookup}>
            <input
              ref={inputRef}
              className="input big"
              style={{ flex: 1, fontSize: 22, letterSpacing: "0.04em" }}
              inputMode="numeric"
              autoComplete="off"
              placeholder="학번"
              aria-label="학번"
              value={sid}
              onChange={(e) => setSid(e.target.value.replace(/[^0-9]/g, ""))}
              autoFocus
            />
            <button
              className="btn primary"
              disabled={busy || sid.length < 4}
              style={{ minWidth: 80 }}
            >
              조회
            </button>
          </form>
          {/* {elapsed !== null && result && <div className="small muted" style={{ marginTop: -6 }}>응답 {(elapsed / 1000).toFixed(2)}초</div>} */}

          {done && (
            <div className="alert good" role="status" style={{ fontSize: 17 }}>
              <strong>
                {done.isLeave
                  ? "재학생 명단 편입 · 투표 완료"
                  : "투표용지 불출 완료"}
              </strong>
              <div className="small">
                {done.missed
                  ? "대조 중 구간 누락분으로 추가했습니다."
                  : `이 창구 누적 ${done.order}번째 불출`}
              </div>
            </div>
          )}

          {result?.result === "ok" && (
            <div
              className="stack"
              style={{
                border: "2px solid var(--accent)",
                borderRadius: 12,
                padding: 14,
              }}
            >
              <div className="row between">
                <div>
                  <div style={{ fontSize: 24, fontWeight: 800 }}>
                    {result.name}
                  </div>
                  <div className="muted">
                    {result.sid} · {result.dept || "학과 미기재"}
                  </div>
                </div>
                <span
                  className={`pill ${result.kind === "regular" ? "accent" : "warn"}`}
                >
                  {result.kind === "regular" ? "정회원" : "준회원(휴학)"}
                </span>
              </div>
              {result.desk_warning && (
                <div className="alert warn" role="alert">
                  <strong>{result.desk_warning.dept} 학생입니다.</strong>{" "}
                  {result.desk_warning.desk_name
                    ? `${result.desk_warning.desk_name} 창구로 안내하세요.`
                    : "이 창구가 맡는 학과가 아닙니다."}
                </div>
              )}
              {result.kind === "associate" && (
                <div className="alert warn small">
                  휴학생 · 투표하면 재학생 명단(유권자)에 편입됩니다.
                </div>
              )}
              <label className="row" style={{ gap: 10, fontSize: 17 }}>
                <input
                  type="checkbox"
                  checked={idChecked}
                  onChange={(e) => setIdChecked(e.target.checked)}
                  style={{ width: 24, height: 24 }}
                />
                신분증(학생증) 확인함
              </label>
              <button
                className="btn primary block"
                style={{ minHeight: 52, fontSize: 18 }}
                disabled={!idChecked || busy}
                onClick={issue}
              >
                투표용지 불출
              </button>
            </div>
          )}
          {result?.result === "voted" && (
            <div
              className="stack"
              style={{
                background: "var(--danger-soft)",
                border: "2px solid var(--danger)",
                borderRadius: 12,
                padding: 14,
              }}
            >
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 800,
                  color: "var(--danger)",
                }}
              >
                이미 투표함
              </div>
              <div>
                {result.name} · {result.sid} · {result.dept}
              </div>
              <div className="muted">
                {fmtHM(result.voted_at)} · {result.voted_station_name} 투표소
              </div>
            </div>
          )}
          {result?.result === "other_district" && (
            <div className="alert warn" style={{ fontSize: 17 }}>
              <strong>{result.district_name} 선거구 학생입니다</strong>
              <div>{result.station_names.join(", ")} 투표소로 안내하세요.</div>
            </div>
          )}
          {result?.result === "not_found" && (
            <div className="alert danger" style={{ fontSize: 17 }}>
              <strong>선거인명부에 없습니다</strong>
              <div>{result.sid} · 투표할 수 없습니다.</div>
            </div>
          )}
        </div>
      )}

      {/* 최근 내 체크 */}
      {status && status.recent.length > 0 && (
        <div className="card">
          <h2 style={{ marginBottom: 8 }}>
            {isStation ? "이 기기의 최근 체크" : "최근 내 체크"}
          </h2>
          <div className="list">
            {status.recent.map((e) => {
              const canCancel =
                !e.canceled &&
                (isAdmin || now - Date.parse(e.at) < OWN_CANCEL_MS);
              return (
                <div key={e.id} className="list-item">
                  <div>
                    <div className="title">
                      {fmtHM(e.at)} {e.is_leave ? "· 준회원" : ""}
                      {e.source === "missed" ? " · 누락분" : ""}
                    </div>
                    <div className="sub">{e.canceled ? "취소됨" : "불출"}</div>
                  </div>
                  <div className="right">
                    {canCancel && (
                      <button
                        className="btn sm ghost"
                        disabled={busy}
                        onClick={() => cancel(e.id)}
                      >
                        취소
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>
            {isStation ? "이 기기에서 한 체크는" : "본인 체크는"} 5분 안에,
            대조가 끝나기 전 구간만 취소할 수 있습니다.
          </p>
        </div>
      )}

      {/* 문제 발생 시 연락 안내 */}
      <div className="alert info" role="note">
        <p style={{ margin: 0 }}>
          만약 시스템 및 총학생회 투표 관련 문제 발생 시 즉시 각 선거구
          중앙선거관리위원이나 중선관위에 보고하여 주시기 바랍니다.
        </p>
        <p style={{ margin: "8px 0 0" }}>
          중선관위원이 없는 경우 중앙선거관리부위원장{" "}
          <a href="tel:01066112732" style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
            010-6611-2732
          </a>
          로 전화하시기 바랍니다.
        </p>
      </div>

      <Sheet
        open={operatorOpen}
        onClose={() => setOperatorOpen(false)}
        title="담당자 변경"
      >
        {operatorOpen && (
          <OperatorForm
            current={operator}
            currentDeskId={rm.device?.desk_id}
            onDone={afterOperator}
            onCancel={() => setOperatorOpen(false)}
          />
        )}
      </Sheet>

      <Sheet
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="꼬리표 마감"
      >
        <div className="stack">
          <p style={{ fontSize: 17, margin: 0 }}>
            지금 담당자가 <strong>{operator}</strong> 맞나요?
          </p>
          <p className="muted small" style={{ margin: 0 }}>
            지금 시각으로 마감하면 이후 체크는 다음 구간으로 들어갑니다.
          </p>
          <button
            className="btn primary block"
            disabled={busy}
            onClick={beginClose}
          >
            네, 지금 마감
          </button>
          <button
            className="btn block"
            onClick={() => {
              setConfirmClose(false);
              setOperatorOpen(true);
            }}
          >
            아니요, 담당자 변경
          </button>
        </div>
      </Sheet>

      <Sheet
        open={closeOpen && !!rec}
        onClose={() => setCloseOpen(false)}
        title="꼬리표 대조"
      >
        {rec && (
          <div className="stack">
            <div className="row between">
              <span className="muted">구간</span>
              <strong>
                {fmtHM(rec.opened_at)} ~ {fmtHM(rec.boundary_at)}
              </strong>
            </div>
            <p style={{ margin: 0 }}>
              이 창구에서 <strong>첫날부터 지금까지 뗀 꼬리표를 전부</strong> 세어
              넣으세요. 다 쓴 묶음은 100장으로 셉니다.
            </p>
            <div className="field">
              <label htmlFor="tag-total">꼬리표 누적 수</label>
              <input
                id="tag-total"
                className="input big"
                inputMode="numeric"
                autoFocus
                value={tagInput}
                onChange={(e) => {
                  setTagInput(e.target.value.replace(/[^0-9]/g, "").slice(0, 5));
                  setMismatch(null);
                }}
                placeholder="예: 137"
              />
            </div>
            {status && status.window_issues.length > 0 && (
              <div className="small muted">
                이 구간에 신고된 이슈 {status.window_issues.length}건
              </div>
            )}
            {mismatch && (
              <div className="alert danger">
                <strong>{mismatch}</strong>
                <ul
                  className="small"
                  style={{ margin: "6px 0 0", paddingLeft: 18 }}
                >
                  <li>꼬리표를 처음부터 한 번 더 세어 보세요.</li>
                  <li>
                    체크 없이 용지를 준 학생이 있으면 아래 "누락분 추가"로 그
                    학번을 체크하세요.
                  </li>
                  <li>
                    용지를 주지 않았는데 체크된 건은 취소하세요 (5분 지난 건은
                    총관리자).
                  </li>
                  <li>
                    그래도 맞지 않으면 "이슈 신고"로 사유를 남기고 총관리자에게
                    조정을 요청하세요.
                  </li>
                </ul>
              </div>
            )}
            <button
              className="btn primary block"
              disabled={busy || tagInput === ""}
              onClick={submitTags}
            >
              대조 저장
            </button>
            {mismatch && (
              <button
                className="btn block"
                onClick={() => {
                  setMissedMode(true);
                  setCloseOpen(false);
                  setTimeout(() => inputRef.current?.focus(), 300);
                }}
              >
                누락분 추가 (학번 조회)
              </button>
            )}
            {isAdmin && (
              <Link to="/reconcile" className="btn ghost block">
                대조 현황에서 조정
              </Link>
            )}
          </div>
        )}
      </Sheet>
      <Sheet open={issueOpen} onClose={() => setIssueOpen(false)} title="꼬리표 이슈 신고">
        {issueOpen && (
          <IssueForm
            stationId={stationId}
            deskId={deskArg}
            onDone={() => {
              setIssueOpen(false);
              loadStatus();
            }}
          />
        )}
      </Sheet>
    </main>
  );
}
