-- Supabase SQL 편집기에서 한 번 실행하세요.
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
