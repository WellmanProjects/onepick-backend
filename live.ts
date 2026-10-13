import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient, upsertChunked } from "./db.js";
import { getProvider } from "./provider.js";
import { syncGameweeks } from "./ingest.js";
import type { DataProvider } from "./types.js";

/**
 * Refresh points for every gameweek whose deadline has passed and whose bonus points are not yet final.
 * Rows stay `provisional` until the feed says the gameweek is data_checked (bonus points confirmed).
 */
export async function runLive(db: SupabaseClient, provider: DataProvider, now = new Date()) {
  const [stat, fixtures] = await Promise.all([provider.fetchStatic(), provider.fetchFixtures()]);
  await syncGameweeks(db, stat.gameweeks, fixtures);

  // Poll gameweeks that are in progress, plus any the feed has just marked final but whose stored rows are still provisional
  // (one last fetch picks up the confirmed bonus points before we stop polling them).
  const { data: prov, error: pe } = await db.from("player_gw_points").select("gameweek_id").eq("provisional", true);
  if (pe) throw new Error(pe.message);
  const provisionalGws = new Set((prov ?? []).map((r: { gameweek_id: number }) => r.gameweek_id));
  const open = stat.gameweeks.filter((g) => g.id <= 38 && new Date(g.deadline_at) <= now && (!g.data_checked || provisionalGws.has(g.id)));
  const { data: known, error } = await db.from("players").select("id");
  if (error) throw new Error(error.message);
  const knownIds = new Set((known ?? []).map((p: { id: number }) => p.id));

  const summary: Record<number, number> = {};
  for (const gw of open) {
    const live = await provider.fetchLive(gw.id);
    const rows = live
      .filter((l) => knownIds.has(l.player_id))
      .map((l) => ({
        player_id: l.player_id, gameweek_id: gw.id, points: l.points, minutes: l.minutes,
        breakdown: l.breakdown, provisional: !gw.data_checked, updated_at: now.toISOString(),
      }));
    await upsertChunked(db, "player_gw_points", rows, "player_id,gameweek_id");
    summary[gw.id] = rows.length;
  }

  return { refreshed: summary };
}

if (process.argv[1]?.endsWith("live.ts")) {
  runLive(serviceClient(), getProvider())
    .then((r) => console.log("Live update complete:", JSON.stringify(r)))
    .catch((e) => { console.error(e); process.exit(1); });
}
