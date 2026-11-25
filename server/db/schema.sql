-- Supabase SQL 편집기에서 실행하세요. 여러 번 실행해도 안전합니다 (v1.1 선거인명부, v1.2 투표소 계정, v1.4 창구·묶음·이슈 추가분 포함).
create table if not exists election (
  id text primary key, name text not null, threshold_pct numeric not null default 50,
  extension_enabled boolean not null default false, input_locked boolean not null default false,
  enforce_time_window boolean not null default true);
create table if not exists election_day (
  id text primary key, date text not null unique, is_extension boolean not null default false, sort int not null);
create table if not exists district (
  id text primary key, name text not null, sort int not null, base_voters int not null default 0);
create table if not exists station (
  id text primary key, district_id text not null references district(id), name text not null, sort int not null,
  open_time text not null, close_time text not null);
create table if not exists slot (
  id text primary key, station_id text not null references station(id), day_id text not null references election_day(id),
  time text not null, is_close boolean not null default false, unique(station_id, day_id, time));
create table if not exists member (
  id text primary key, name text not null, role text not null, code_hash text not null,
  code_version int not null default 1, active boolean not null default true, created_at text not null,
  last_login_at text, failed_count int not null default 0, locked_until text);
create table if not exists entry (
  id text primary key, station_id text not null references station(id), slot_id text not null references slot(id),
  cumulative int not null, leave_cumulative int not null,
  entered_by text not null, entered_by_name text not null, entered_at text not null,
  confirmed boolean not null default false, confirmed_by text, confirmed_at text, unique(station_id, slot_id));
create table if not exists change_request (
  id text primary key, entry_id text not null references entry(id), new_cumulative int not null, new_leave_cumulative int not null,
  reason text not null, requested_by text not null, requested_by_name text not null, requested_at text not null,
  status text not null, decided_by text, decided_by_name text, decided_at text, decision_note text);
create table if not exists audit_log (
  id text primary key, at text not null, actor_id text not null, actor_name text not null, action text not null,
  station_id text, slot_id text, before_json text, after_json text, note text);
-- 서비스 키로만 접근하므로 RLS를 켜고 정책은 두지 않습니다 (anon 접근 차단).
alter table election enable row level security;
alter table election_day enable row level security;
alter table district enable row level security;
alter table station enable row level security;
alter table slot enable row level security;
alter table member enable row level security;
alter table entry enable row level security;
alter table change_request enable row level security;
alter table audit_log enable row level security;

-- ============================================================
-- v1.1 선거인명부 확인·불출·꼬리표 대조 (2026-11-05 추가)
-- 이미 배포된 프로젝트도 이 파일 전체를 다시 실행하면 됩니다.
-- ============================================================
alter table election add column if not exists result_announced_on text;
alter table election add column if not exists retention_days int not null default 7;
alter table election add column if not exists purged_at text;
alter table election add column if not exists roster_upload text;
alter table election add column if not exists last_backup_at text;
alter table member add column if not exists pledged_at text;

create table if not exists voter (
  id text primary key, sid_hash text not null unique, name_enc text not null, dept_enc text not null,
  district_id text not null references district(id), kind text not null check (kind in ('regular','associate')),
  voted_at text, voted_station_id text, voted_event_id text, batch_id text, source text not null, created_at text not null);
create index if not exists voter_batch_idx on voter(batch_id);
create table if not exists ballot_event (
  id text primary key, voter_id text not null, voter_sid_hash text not null, station_id text not null,
  kind text not null check (kind in ('issue','cancel')), ref_event_id text, is_leave boolean not null,
  at text not null, actor_id text not null, actor_name text not null, window_id text, source text not null, reason text);
create index if not exists ballot_event_station_idx on ballot_event(station_id, window_id);
create index if not exists ballot_event_ref_idx on ballot_event(ref_event_id);
create index if not exists ballot_event_actor_idx on ballot_event(actor_id, at);
create table if not exists tally_window (
  id text primary key, station_id text not null references station(id), date text not null,
  opened_at text not null, boundary_at text not null, status text not null,
  check_count int not null, leave_count int not null, tag_count int, accepted_count int,
  adjustment int not null default 0, adjust_reason text,
  closed_by text not null, closed_by_name text not null, matched_at text, matched_by_name text);
create index if not exists tally_window_station_idx on tally_window(station_id, boundary_at);
-- 근무표(shift)는 v1.2에서 투표소 공용 계정으로 바뀌며 쓰지 않게 되어 없앤다.
drop table if exists shift;
create table if not exists voter_access_log (
  id text primary key, at text not null, member_id text not null, member_name text not null, station_id text,
  action text not null, sid_hash8 text, result text, note text);
create index if not exists voter_access_log_at_idx on voter_access_log(at);
-- 체크한 학번 (FR-130): 선거인별로 암호화한 학번 한 줄. id = voter.id
create table if not exists voter_sid (id text primary key, sid_enc text not null, created_at text not null);
alter table voter_sid enable row level security;
alter table voter enable row level security;
alter table ballot_event enable row level security;
alter table tally_window enable row level security;
alter table voter_access_log enable row level security;

-- ============================================================
-- v1.2 투표소 공용 계정·기기 세션 (2026-11-06 추가, 근무표 대체)
-- ============================================================
alter table member add column if not exists station_id text;
alter table ballot_event add column if not exists operator_name text;
alter table ballot_event add column if not exists device_id text;
alter table tally_window add column if not exists operator_name text;
alter table voter_access_log add column if not exists operator_name text;
create table if not exists device_session (
  id text primary key, member_id text not null references member(id), station_id text not null references station(id),
  device_no int not null, created_at text not null, expires_at text not null, last_seen_at text not null,
  operator_name text, operator_since text, operator_pledged_at text, revoked_at text, user_agent text);
create index if not exists device_session_station_idx on device_session(station_id, created_at);
create table if not exists operator_log (
  id text primary key, device_id text not null references device_session(id), station_id text not null,
  operator_name text not null, started_at text not null);
create index if not exists operator_log_device_idx on operator_log(device_id, started_at);
create index if not exists ballot_event_device_idx on ballot_event(device_id, at);
alter table device_session enable row level security;
alter table operator_log enable row level security;

-- ============================================================
-- v1.4 창구 단위 대조·꼬리표 일련번호·이슈 신고 (2026-11-16 추가)
-- ============================================================
alter table ballot_event add column if not exists desk_id text;
alter table tally_window add column if not exists desk_id text;
alter table tally_window add column if not exists pad_json text;
alter table device_session add column if not exists desk_id text;
create table if not exists desk (
  id text primary key, station_id text not null, name text not null, depts text not null default '[]',
  is_all boolean not null default false, is_unassigned boolean not null default false,
  created_at text not null, created_by text not null, merged_into text);
create index if not exists desk_station_idx on desk(station_id);
create table if not exists dept (
  id text primary key, district_id text not null, name text not null, unique(district_id, name));
create table if not exists ballot_pad (
  id text primary key, station_id text not null, desk_id text not null, first_no int not null unique, last_no int not null,
  used_no int, used_total int not null default 0, by_count boolean not null default false,
  opened_at text not null, opened_by text not null, device_id text, exhausted_at text);
create index if not exists ballot_pad_desk_idx on ballot_pad(desk_id);
create table if not exists pad_reading (
  id text primary key, window_id text not null, pad_id text not null, last_no int, prev_total int not null,
  used_total int not null, by_count boolean not null default false);
create index if not exists pad_reading_window_idx on pad_reading(window_id);
create table if not exists pad_move (
  id text primary key, pad_id text not null, from_desk_id text not null, to_desk_id text not null, at text not null,
  operator_name text not null, device_id text);
create table if not exists tag_issue (
  id text primary key, station_id text not null, desk_id text, window_id text, pad_id text, type text not null,
  serial_from int, serial_to int, count int not null default 1, note text, device_id text, operator_name text not null, at text not null,
  reviewed_by text, reviewed_at text, voided_by text, voided_at text, void_reason text);
create index if not exists tag_issue_station_idx on tag_issue(station_id, at);
create index if not exists ballot_event_desk_idx on ballot_event(desk_id, window_id);
alter table desk enable row level security;
alter table dept enable row level security;
alter table ballot_pad enable row level security;
alter table pad_reading enable row level security;
alter table pad_move enable row level security;
alter table tag_issue enable row level security;

-- 체크 기록은 추가만 가능: 삭제 금지, 수정은 비어 있는 구간 번호(window_id)를 한 번 채우는 것만 허용.
-- 체크 기록 초기화·파기 함수만 vote.allow_purge 를 켜고 지울 수 있다.
create or replace function ballot_event_guard() returns trigger language plpgsql as $$
begin
  if current_setting('vote.allow_purge', true) = 'on' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then raise exception '체크 기록은 지울 수 없습니다 (추가만 가능)'; end if;
  if old.window_id is not null or new.window_id is null
     or (to_jsonb(new) - 'window_id') is distinct from (to_jsonb(old) - 'window_id') then
    raise exception '체크 기록은 고칠 수 없습니다 (추가만 가능)';
  end if;
  return new;
end $$;
drop trigger if exists ballot_event_guard on ballot_event;
create trigger ballot_event_guard before update or delete on ballot_event for each row execute function ballot_event_guard();

create or replace function vote_issue(p jsonb) returns jsonb language plpgsql as $$
declare v_kind text; v_at text; v_st text;
begin
  update voter set voted_at = p->>'at', voted_station_id = p->>'station_id', voted_event_id = p->>'event_id'
    where id = p->>'voter_id' and voted_at is null and batch_id is null
    returning kind into v_kind;
  if not found then
    select voted_at, voted_station_id into v_at, v_st from voter where id = p->>'voter_id';
    return jsonb_build_object('ok', false, 'voted_at', v_at, 'voted_station_id', v_st);
  end if;
  insert into ballot_event(id, voter_id, voter_sid_hash, station_id, kind, ref_event_id, is_leave, at, actor_id, actor_name, window_id, source, reason,
                           operator_name, device_id, desk_id)
  values (p->>'event_id', p->>'voter_id', p->>'sid_hash', p->>'station_id', 'issue', null, v_kind = 'associate',
          p->>'at', p->>'actor_id', p->>'actor_name', p->>'window_id', p->>'source', p->>'reason',
          p->>'operator_name', p->>'device_id', p->>'desk_id');
  return jsonb_build_object('ok', true, 'is_leave', v_kind = 'associate');
end $$;

create or replace function vote_cancel(p jsonb) returns jsonb language plpgsql as $$
declare e ballot_event%rowtype; w_status text; late boolean := false; open_desk text;
begin
  select * into e from ballot_event where id = p->>'issue_id' and kind = 'issue' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if exists (select 1 from ballot_event where ref_event_id = e.id) then
    return jsonb_build_object('ok', false, 'reason', 'already_canceled');
  end if;
  if e.window_id is not null then
    select status into w_status from tally_window where id = e.window_id;
    if w_status is distinct from 'reconciling' then
      -- FR-121: 총관리자는 대조가 끝난 구간의 체크도 취소한다. 끝난 구간은 그대로 두고 취소분은 창구의 열린 구간에 넣는다
      open_desk := coalesce(p->>'open_desk_id', e.desk_id);
      if coalesce(p->>'force', '') <> 'true' or open_desk is null then
        return jsonb_build_object('ok', false, 'reason', 'window_closed');
      end if;
      late := true;
    end if;
  end if;
  insert into ballot_event(id, voter_id, voter_sid_hash, station_id, kind, ref_event_id, is_leave, at, actor_id, actor_name, window_id, source, reason,
                           operator_name, device_id, desk_id)
  values (p->>'cancel_id', e.voter_id, e.voter_sid_hash, e.station_id, 'cancel', e.id, e.is_leave,
          p->>'at', p->>'actor_id', p->>'actor_name', case when late then null else e.window_id end, e.source, p->>'reason',
          p->>'operator_name', p->>'device_id', case when late then open_desk else e.desk_id end);
  update voter set voted_at = null, voted_station_id = null, voted_event_id = null
    where sid_hash = e.voter_sid_hash and voted_event_id = e.id;
  return jsonb_build_object('ok', true, 'late', late);
end $$;

-- v1.4: 구간 배정은 창구 단위. 매개변수 이름이 바뀌어 예전 함수는 먼저 지운다.
drop function if exists vote_assign_window(text, text, text);
create or replace function vote_assign_window(p_desk text, p_window text, p_boundary text) returns void language plpgsql as $$
begin
  update ballot_event set window_id = p_window
    where desk_id = p_desk and window_id is null and kind = 'issue' and at <= p_boundary;
  update ballot_event c set window_id = p_window
    where c.desk_id = p_desk and c.window_id is null and c.kind = 'cancel'
      and (c.ref_event_id in (select id from ballot_event where window_id = p_window)
        -- FR-121: 이미 끝난 구간의 체크를 뒤늦게 취소한 것은 이번 구간에서 뺀다
        or (c.at <= p_boundary and exists (select 1 from ballot_event i where i.id = c.ref_event_id and i.window_id is not null and i.window_id <> p_window)));
end $$;

create or replace function vote_window_counts(p_window text) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'net', coalesce(sum(case when kind = 'issue' then 1 else -1 end), 0),
    'leave_net', coalesce(sum(case when is_leave then (case when kind = 'issue' then 1 else -1 end) else 0 end), 0))
  from ballot_event where window_id = p_window
$$;

create or replace function vote_live_counts() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select station_id, desk_id,
      sum(case when kind = 'issue' then 1 else -1 end)::int as net,
      sum(case when is_leave then (case when kind = 'issue' then 1 else -1 end) else 0 end)::int as leave_net,
      sum(case when window_id is null then (case when kind = 'issue' then 1 else -1 end) else 0 end)::int as open_net,
      sum(case when window_id is null and is_leave then (case when kind = 'issue' then 1 else -1 end) else 0 end)::int as open_leave_net
    from ballot_event group by station_id, desk_id) t
$$;

-- 현황판 시간별 추이 (FR-119): 체크 시각의 시 단위(UTC)별 순 체크 인원
create or replace function vote_hourly_counts() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select substr(at, 1, 13) as hour,
      sum(case when kind = 'issue' then 1 else -1 end)::int as net,
      sum(case when is_leave then (case when kind = 'issue' then 1 else -1 end) else 0 end)::int as leave_net
    from ballot_event group by substr(at, 1, 13)) t
$$;

create or replace function vote_roster_counts() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select district_id, kind, count(*)::int as total, count(voted_at)::int as voted
    from voter where batch_id is null group by district_id, kind) t
$$;

create or replace function vote_reset_checks() returns void language plpgsql as $$
begin
  perform set_config('vote.allow_purge', 'on', true);
  delete from ballot_event where id is not null;
  delete from tally_window where id is not null;
  update voter set voted_at = null, voted_station_id = null, voted_event_id = null where voted_at is not null;
end $$;

create or replace function vote_rebuild_voter_state() returns int language plpgsql as $$
declare n int;
begin
  update voter set voted_at = null, voted_station_id = null, voted_event_id = null where voted_at is not null;
  update voter v set voted_at = e.at, voted_station_id = e.station_id, voted_event_id = e.id
    from ballot_event e
    where e.kind = 'issue' and e.voter_sid_hash = v.sid_hash
      and not exists (select 1 from ballot_event c where c.ref_event_id = e.id);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function vote_purge() returns void language plpgsql as $$
begin
  perform set_config('vote.allow_purge', 'on', true);
  delete from ballot_event where id is not null;
  delete from voter where id is not null;
  delete from voter_sid where id is not null;
  update voter_access_log set sid_hash8 = null where sid_hash8 is not null;
end $$;

-- 함수는 서버(service_role)만 호출할 수 있게 한다.
revoke execute on function vote_issue(jsonb), vote_cancel(jsonb), vote_assign_window(text, text, text), vote_window_counts(text),
  vote_live_counts(), vote_hourly_counts(), vote_roster_counts(), vote_reset_checks(), vote_rebuild_voter_state(), vote_purge()
  from public, anon, authenticated;
grant execute on function vote_issue(jsonb), vote_cancel(jsonb), vote_assign_window(text, text, text), vote_window_counts(text),
  vote_live_counts(), vote_hourly_counts(), vote_roster_counts(), vote_reset_checks(), vote_rebuild_voter_state(), vote_purge()
  to service_role;
