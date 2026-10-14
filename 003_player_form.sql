-- Adds season points and form to players, used for the "Top 3 by position" strip on the pick screen.
-- Safe to run more than once. The Nightly ingest fills these in.
alter table public.players add column if not exists total_points int not null default 0;
alter table public.players add column if not exists form numeric not null default 0;
