# OnePick backend (prototype)

Database, data feed and live scoring for OnePick. Built for the free Fantasy Premier League feed first; the feed is
isolated behind one adapter file so you can move to a licensed provider later.

## What's in here

| Piece | File | What it does |
|---|---|---|
| Database | `supabase/migrations/001_schema.sql` | Tables, the deadline lock, "no repeat player" rule, reset-league picks, standings, row-level security |
| Feed adapter | `src/providers/fpl.ts` | The only file that knows the FPL feed's raw format |
| Nightly ingest | `src/ingest.ts` | Clubs, players, fixtures, gameweek deadlines |
| Live scoring | `src/live.ts` | Pulls points (with a breakdown of what they were for) every ~10 min on match days |
| Schedules | `.github/workflows/*.yml` | Runs both jobs on a timer, free on GitHub |
| Tests | `test/` | 27 tests: feed mapping, the job logic, and every database rule against a real Postgres engine |

## The rules, and where they are enforced (in the database, not the browser)

- **One pick per gameweek, a player only once all season:** unique constraints on `picks`.
- **Lock at the gameweek deadline:** a trigger rejects any insert, change or delete once `deadline_at` has passed.
- **No peeking:** you see your own picks any time; other people's picks only appear after that gameweek's deadline.
- **Reset leagues:** `league_picks` has its own "no repeat inside a round" constraint. The round number is worked out
  by the database from the league's setting (whole season, monthly, or every N gameweeks).
- **Standings:** `standings(league_id, from_gw, to_gw)`. Pass `null` for the two main leagues. Only locked gameweeks count.
  Round tables use the gameweek range for that round (the `month_key` column on `gameweeks` groups gameweeks into months).

## Setup (about 30 minutes)

1. **Supabase project.** Create a free project at supabase.com. In the SQL editor, paste and run `supabase/migrations/001_schema.sql`.
2. **Keys.** Settings → API. Copy the project URL and the `service_role` key.
   The service-role key can bypass all rules, so it only ever goes in the server jobs, never in the website.
3. **Run the first ingest locally** to check it works from your machine:
   ```
   npm install
   cp .env.example .env      # paste the two values in
   export $(grep -v '^#' .env | xargs)
   npm run ingest            # loads clubs, players, fixtures, gameweeks
   npm run live              # pulls points for any gameweek already past its deadline
   ```
4. **Schedules.** Push this folder to a GitHub repo, add the same two values under Settings → Secrets → Actions
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). The workflows then run on their own.
5. **Run the tests any time:** `npm test`.

## Known limits of this prototype

- **The free FPL feed is unofficial.** It has no licence or guarantee and can change or block you. Fine for a private beta.
  Don't launch publicly or take money on it. Swap in a licensed provider by adding a file next to `fpl.ts`.
- **GitHub's scheduler** can run a few minutes late and isn't built for real-time. Fine for 10-minute updates.
  For tighter updates, run the live job on a small always-on server instead.
- **Not tested against the real feed or a hosted Supabase project:** I couldn't reach either from my workspace. Step 3 is
  where any mismatch will show up, and it will be in `src/providers/fpl.ts`.
- **Late joiners, postponed matches and players who miss out through injury** have no special handling yet: points are
  whatever the feed says (zero if the player didn't play).
- **Bonus points** are in the free feed. A licensed raw-event provider would mean working them out yourself.

## Next: connect the website

The website (`onepick.jsx`) still runs on demo storage. Connecting it means: Supabase sign-up/login instead of the PIN
screen; read players, fixtures and deadlines from the tables; pick = insert/delete on `picks` (or `league_picks`);
leagues via `create_league` / `join_league`; tables via `standings`; and the "Your season" breakdown from
`player_gw_points.breakdown`.
