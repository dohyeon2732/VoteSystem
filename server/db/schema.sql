-- Supabase SQL 편집기에서 실행하세요. 여러 번 실행해도 안전합니다 (v1.1 선거인명부 추가분 포함).
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
create table if not exists shift (
  id text primary key, member_id text not null references member(id), station_id text not null references station(id),
  date text not null, start_time text not null, end_time text not null);
create table if not exists voter_access_log (
  id text primary key, at text not null, member_id text not null, member_name text not null, station_id text,
  action text not null, sid_hash8 text, result text, note text);
create index if not exists voter_access_log_at_idx on voter_access_log(at);
alter table voter enable row level security;
alter table ballot_event enable row level security;
alter table tally_window enable row level security;
alter table shift enable row level security;
alter table voter_access_log enable row level security;

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
  insert into ballot_event(id, voter_id, voter_sid_hash, station_id, kind, ref_event_id, is_leave, at, actor_id, actor_name, window_id, source, reason)
  values (p->>'event_id', p->>'voter_id', p->>'sid_hash', p->>'station_id', 'issue', null, v_kind = 'associate',
          p->>'at', p->>'actor_id', p->>'actor_name', p->>'window_id', p->>'source', p->>'reason');
  return jsonb_build_object('ok', true, 'is_leave', v_kind = 'associate');
end $$;

create or replace function vote_cancel(p jsonb) returns jsonb language plpgsql as $$
declare e ballot_event%rowtype; w_status text;
begin
  select * into e from ballot_event where id = p->>'issue_id' and kind = 'issue' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if exists (select 1 from ballot_event where ref_event_id = e.id) then
    return jsonb_build_object('ok', false, 'reason', 'already_canceled');
  end if;
  if e.window_id is not null then
    select status into w_status from tally_window where id = e.window_id;
    if w_status is distinct from 'reconciling' then return jsonb_build_object('ok', false, 'reason', 'window_closed'); end if;
  end if;
  insert into ballot_event(id, voter_id, voter_sid_hash, station_id, kind, ref_event_id, is_leave, at, actor_id, actor_name, window_id, source, reason)
  values (p->>'cancel_id', e.voter_id, e.voter_sid_hash, e.station_id, 'cancel', e.id, e.is_leave,
          p->>'at', p->>'actor_id', p->>'actor_name', e.window_id, e.source, p->>'reason');
  update voter set voted_at = null, voted_station_id = null, voted_event_id = null
    where sid_hash = e.voter_sid_hash and voted_event_id = e.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function vote_assign_window(p_station text, p_window text, p_boundary text) returns void language plpgsql as $$
begin
  update ballot_event set window_id = p_window
    where station_id = p_station and window_id is null and kind = 'issue' and at <= p_boundary;
  update ballot_event c set window_id = p_window
    where c.station_id = p_station and c.window_id is null and c.kind = 'cancel'
      and c.ref_event_id in (select id from ballot_event where window_id = p_window);
end $$;

create or replace function vote_window_counts(p_window text) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'net', coalesce(sum(case when kind = 'issue' then 1 else -1 end), 0),
    'leave_net', coalesce(sum(case when is_leave then (case when kind = 'issue' then 1 else -1 end) else 0 end), 0))
  from ballot_event where window_id = p_window
$$;

create or replace function vote_live_counts() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select station_id,
      sum(case when kind = 'issue' then 1 else -1 end)::int as net,
      sum(case when is_leave then (case when kind = 'issue' then 1 else -1 end) else 0 end)::int as leave_net,
      sum(case when window_id is null then (case when kind = 'issue' then 1 else -1 end) else 0 end)::int as open_net,
      sum(case when window_id is null and is_leave then (case when kind = 'issue' then 1 else -1 end) else 0 end)::int as open_leave_net
    from ballot_event group by station_id) t
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
  update voter_access_log set sid_hash8 = null where sid_hash8 is not null;
end $$;

-- 함수는 서버(service_role)만 호출할 수 있게 한다.
revoke execute on function vote_issue(jsonb), vote_cancel(jsonb), vote_assign_window(text, text, text), vote_window_counts(text),
  vote_live_counts(), vote_roster_counts(), vote_reset_checks(), vote_rebuild_voter_state(), vote_purge()
  from public, anon, authenticated;
grant execute on function vote_issue(jsonb), vote_cancel(jsonb), vote_assign_window(text, text, text), vote_window_counts(text),
  vote_live_counts(), vote_roster_counts(), vote_reset_checks(), vote_rebuild_voter_state(), vote_purge()
  to service_role;
