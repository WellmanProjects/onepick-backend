-- OnePick database schema (Supabase / Postgres 15+)
-- Run in the Supabase SQL editor, or with `supabase db push`.

-- ───────────────────────── Reference data (filled by the ingest job) ─────────────────────────
create table public.teams (
  id          int primary key,            -- FPL team id
  name        text not null,
  short_name  text not null,
  code        int                         -- FPL badge code (not used for crests yet)
);

create table public.players (
  id          int primary key,            -- FPL element id
  web_name    text not null,
  first_name  text,
  second_name text,
  team_id     int not null references public.teams(id),
  position    text not null check (position in ('GK','DEF','MID','FWD')),
  status      text not null default 'a',  -- a=available, i=injured, d=doubtful, s=suspended, u=unavailable
  news        text,
  now_cost    int,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);
create index on public.players (team_id);

create table public.gameweeks (
  id             int primary key check (id between 1 and 38),
  name           text,
  deadline_at    timestamptz not null,    -- picks lock at this moment
  first_kickoff  timestamptz,
  month_key      text,                    -- 'YYYY-MM' (Europe/London) of the first kickoff; drives monthly rounds
  finished       boolean not null default false,
  data_checked   boolean not null default false  -- true once bonus points are final
);

create table public.fixtures (
  id            int primary key,
  gameweek_id   int references public.gameweeks(id),   -- null while unscheduled
  home_team_id  int not null references public.teams(id),
  away_team_id  int not null references public.teams(id),
  kickoff_at    timestamptz,
  started       boolean not null default false,
  finished      boolean not null default false,
  home_score    int,
  away_score    int
);
create index on public.fixtures (gameweek_id);

-- One row per player per gameweek. Double gameweeks are already summed by the live job.
create table public.player_gw_points (
  player_id    int not null references public.players(id),
  gameweek_id  int not null references public.gameweeks(id),
  points       int not null default 0,
  minutes      int not null default 0,
  breakdown    jsonb not null default '[]',   -- [{label, value, points}]
  provisional  boolean not null default true,
  updated_at   timestamptz not null default now(),
  primary key (player_id, gameweek_id)
);

-- ───────────────────────── Users ─────────────────────────
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique check (char_length(username) between 3 and 20),
  created_at  timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', 'gaffer_' || substr(new.id::text, 1, 6)));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────── Main-game picks ─────────────────────────
create table public.picks (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  gameweek_id  int  not null references public.gameweeks(id),
  player_id    int  not null references public.players(id),
  created_at   timestamptz not null default now(),
  unique (user_id, gameweek_id),   -- one pick per gameweek
  unique (user_id, player_id)      -- a player can only be used once all season
);

-- Lock helper: picks cannot be created, changed or removed once the gameweek deadline has passed.
create function public.assert_gw_open(gw int) returns void
language plpgsql stable as $$
declare dl timestamptz;
begin
  if coalesce(current_setting('onepick.bypass_lock', true), '') = 'on' then return; end if;
  select deadline_at into dl from public.gameweeks where id = gw;
  if dl is null then raise exception 'Unknown gameweek %', gw using errcode = 'P0001'; end if;
  if now() >= dl then raise exception 'Gameweek % is locked (deadline passed)', gw using errcode = 'P0001'; end if;
end $$;

create function public.picks_lock_guard() returns trigger
language plpgsql as $$
begin
  if tg_op in ('UPDATE','DELETE') then perform public.assert_gw_open(old.gameweek_id); end if;
  if tg_op in ('INSERT','UPDATE') then perform public.assert_gw_open(new.gameweek_id); end if;
  return coalesce(new, old);
end $$;
create trigger picks_lock before insert or update or delete on public.picks
  for each row execute function public.picks_lock_guard();

-- ───────────────────────── Leagues ─────────────────────────
create table public.leagues (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null check (char_length(name) between 2 and 40),
  owner_id      uuid not null references public.profiles(id),
  round_type    text not null check (round_type in ('season','monthly','gameweeks')),
  round_length  int,
  reset_picks   boolean not null default false,   -- players come back each round; members make separate league picks
  created_at    timestamptz not null default now(),
  check (round_type <> 'gameweeks' or round_length between 2 and 19),
  check (not reset_picks or round_type <> 'season')
);

create table public.league_members (
  league_id  uuid not null references public.leagues(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (league_id, user_id)
);

create function public.is_league_member(lid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.league_members where league_id = lid and user_id = auth.uid());
$$;

-- Which round does a gameweek fall into for this league? (1-based)
create function public.league_round_index(lid uuid, gw int) returns int
language plpgsql stable as $$
declare l public.leagues; mk text;
begin
  select * into l from public.leagues where id = lid;
  if l.round_type = 'season' then return 1; end if;
  if l.round_type = 'gameweeks' then return ((gw - 1) / l.round_length) + 1; end if;
  select month_key into mk from public.gameweeks where id = gw;
  return (select count(distinct month_key) from public.gameweeks where month_key <= mk);
end $$;

-- Picks for leagues with reset_picks = true.
create table public.league_picks (
  id           bigint generated always as identity primary key,
  league_id    uuid not null references public.leagues(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  gameweek_id  int  not null references public.gameweeks(id),
  player_id    int  not null references public.players(id),
  round_index  int  not null,
  created_at   timestamptz not null default now(),
  unique (league_id, user_id, gameweek_id),
  unique (league_id, user_id, round_index, player_id)   -- no repeats inside a round; free again next round
);

create function public.league_picks_guard() returns trigger
language plpgsql as $$
declare l public.leagues;
begin
  if tg_op in ('UPDATE','DELETE') then perform public.assert_gw_open(old.gameweek_id); end if;
  if tg_op = 'DELETE' then return old; end if;
  perform public.assert_gw_open(new.gameweek_id);
  select * into l from public.leagues where id = new.league_id;
  if not l.reset_picks then raise exception 'This league does not use separate picks'; end if;
  if not exists (select 1 from public.league_members where league_id = new.league_id and user_id = new.user_id) then
    raise exception 'Not a member of this league';
  end if;
  new.round_index := public.league_round_index(new.league_id, new.gameweek_id);
  return new;
end $$;
create trigger league_picks_guard before insert or update or delete on public.league_picks
  for each row execute function public.league_picks_guard();

-- Create / join leagues through functions so codes and membership are controlled server-side.
create function public.create_league(p_name text, p_round_type text, p_round_length int default null, p_reset boolean default false)
returns public.leagues language plpgsql security definer set search_path = public as $$
declare l public.leagues; c text; chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  loop
    c := '';
    for i in 1..5 loop c := c || substr(chars, 1 + floor(random() * 32)::int, 1); end loop;
    exit when not exists (select 1 from public.leagues where code = c);
  end loop;
  insert into public.leagues (code, name, owner_id, round_type, round_length, reset_picks)
  values (c, p_name, auth.uid(), p_round_type, p_round_length, p_reset) returning * into l;
  insert into public.league_members (league_id, user_id) values (l.id, auth.uid());
  return l;
end $$;

create function public.join_league(p_code text) returns public.leagues
language plpgsql security definer set search_path = public as $$
declare l public.leagues;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into l from public.leagues where code = upper(trim(p_code));
  if l.id is null then raise exception 'No league found with that code'; end if;
  insert into public.league_members (league_id, user_id) values (l.id, auth.uid()) on conflict do nothing;
  return l;
end $$;

-- ───────────────────────── Standings ─────────────────────────
-- p_league_id = null  → main leagues (everyone, main picks).
-- Only gameweeks whose deadline has passed count, so nothing is revealed early.
create function public.standings(p_league_id uuid default null, p_from int default 1, p_to int default 38)
returns table (user_id uuid, username text, points bigint, rank bigint)
language plpgsql stable security definer set search_path = public as $$
declare use_league_picks boolean := false;
begin
  if p_league_id is not null then
    if not public.is_league_member(p_league_id) then raise exception 'Not a member of this league'; end if;
    select reset_picks into use_league_picks from public.leagues where id = p_league_id;
  end if;

  return query
  with members as (
    select pr.id as uid, pr.username from public.profiles pr
    where p_league_id is null
       or pr.id in (select lm.user_id from public.league_members lm where lm.league_id = p_league_id)
  ), chosen as (
    select p.user_id as uid, p.gameweek_id as gw, p.player_id as pid from public.picks p
      where not use_league_picks
    union all
    select lp.user_id, lp.gameweek_id, lp.player_id from public.league_picks lp
      where use_league_picks and lp.league_id = p_league_id
  ), scored as (
    select c.uid, coalesce(sum(pg.points), 0) as pts
    from chosen c
    join public.gameweeks g on g.id = c.gw and g.deadline_at <= now()
    left join public.player_gw_points pg on pg.player_id = c.pid and pg.gameweek_id = c.gw
    where c.gw between p_from and p_to
    group by c.uid
  )
  select m.uid, m.username, coalesce(s.pts, 0)::bigint, rank() over (order by coalesce(s.pts, 0) desc)
  from members m left join scored s on s.uid = m.uid
  order by 3 desc, 2;
end $$;

-- ───────────────────────── Row level security ─────────────────────────
alter table public.teams            enable row level security;
alter table public.players          enable row level security;
alter table public.gameweeks        enable row level security;
alter table public.fixtures         enable row level security;
alter table public.player_gw_points enable row level security;
alter table public.profiles         enable row level security;
alter table public.picks            enable row level security;
alter table public.leagues          enable row level security;
alter table public.league_members   enable row level security;
alter table public.league_picks     enable row level security;

-- Football data is public read-only (the ingest job uses the service role, which bypasses RLS).
create policy read_teams     on public.teams            for select using (true);
create policy read_players   on public.players         for select using (true);
create policy read_gameweeks on public.gameweeks        for select using (true);
create policy read_fixtures  on public.fixtures         for select using (true);
create policy read_points    on public.player_gw_points for select using (true);

create policy read_profiles  on public.profiles for select using (true);
create policy edit_own_profile on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- "No peeking": your own picks any time; everyone else's only after that gameweek's deadline.
create policy read_picks on public.picks for select using (
  user_id = auth.uid()
  or exists (select 1 from public.gameweeks g where g.id = gameweek_id and g.deadline_at <= now()));
create policy add_own_pick    on public.picks for insert with check (user_id = auth.uid());
create policy change_own_pick on public.picks for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy delete_own_pick on public.picks for delete using (user_id = auth.uid());

create policy read_my_leagues on public.leagues for select using (public.is_league_member(id));
create policy read_league_members on public.league_members for select using (public.is_league_member(league_id));
create policy leave_league on public.league_members for delete using (user_id = auth.uid());

create policy read_league_picks on public.league_picks for select using (
  public.is_league_member(league_id) and (
    user_id = auth.uid()
    or exists (select 1 from public.gameweeks g where g.id = gameweek_id and g.deadline_at <= now())));
create policy add_own_league_pick    on public.league_picks for insert with check (user_id = auth.uid());
create policy change_own_league_pick on public.league_picks for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy delete_own_league_pick on public.league_picks for delete using (user_id = auth.uid());

-- Supabase grants table access to these roles by default; spelled out here so it is explicit.
grant usage on schema public to anon, authenticated;
grant select on public.teams, public.players, public.gameweeks, public.fixtures, public.player_gw_points, public.profiles to anon, authenticated;
grant select, insert, update, delete on public.picks, public.league_picks to authenticated;
grant select on public.leagues, public.league_members to authenticated;
grant delete on public.league_members to authenticated;
grant update (username) on public.profiles to authenticated;
grant execute on function public.create_league(text, text, int, boolean), public.join_league(text), public.standings(uuid, int, int) to authenticated;
