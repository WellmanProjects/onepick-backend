import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient, upsertChunked } from "./db.js";
import { getProvider } from "./provider.js";
import { monthKey } from "./month.js";
import type { DataProvider, Fixture, Gameweek } from "./types.js";

/** Refresh gameweek rows (deadlines, finished flags). Also used by the live job. */
export async function syncGameweeks(db: SupabaseClient, gameweeks: Gameweek[], fixtures: Fixture[]) {
  const firstKick = new Map<number, string>();
  for (const f of fixtures) {
    if (f.gameweek_id == null || !f.kickoff_at) continue;
    const cur = firstKick.get(f.gameweek_id);
    if (!cur || f.kickoff_at < cur) firstKick.set(f.gameweek_id, f.kickoff_at);
  }
  const rows = gameweeks.filter((g) => g.id >= 1 && g.id <= 38).map((g) => {
    const fk = firstKick.get(g.id) ?? null;
    return { ...g, first_kickoff: fk, month_key: monthKey(fk ?? g.deadline_at) };
  });
  await upsertChunked(db, "gameweeks", rows, "id");
}

/** Full refresh of teams, players, gameweeks and fixtures. Safe to run as often as you like. */
export async function runIngest(db: SupabaseClient, provider: DataProvider) {
  const [stat, fixtures] = await Promise.all([provider.fetchStatic(), provider.fetchFixtures()]);
  await upsertChunked(db, "teams", stat.teams, "id");
  await upsertChunked(db, "players", stat.players.map((p) => ({ ...p, active: true, updated_at: new Date().toISOString() })), "id");
  await syncGameweeks(db, stat.gameweeks, fixtures);
  await upsertChunked(db, "fixtures", fixtures, "id");
  return { teams: stat.teams.length, players: stat.players.length, gameweeks: stat.gameweeks.length, fixtures: fixtures.length };
}

if (process.argv[1]?.endsWith("ingest.ts")) {
  const db = serviceClient(), provider = getProvider();
  // The nightly run also scores any finished gameweeks, so points are filled in even without the live job
  runIngest(db, provider)
    .then(async (r) => { console.log("Ingest complete:", r); const { runLive } = await import("./live.js"); console.log("Points updated:", JSON.stringify(await runLive(db, provider))); })
    .catch((e) => { console.error(e); process.exit(1); });
}
