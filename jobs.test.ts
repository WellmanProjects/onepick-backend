import { describe, it, expect } from "vitest";
import { runIngest } from "../src/ingest";
import { runLive } from "../src/live";
import type { DataProvider } from "../src/types";

// A tiny in-memory stand-in for the Supabase client: just the calls the jobs make.
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = { ...seed };
  const keyOf = (t: string, onConflict: string, r: any) => onConflict.split(",").map((k) => r[k]).join("|");
  return {
    tables,
    from(t: string) {
      tables[t] ??= [];
      return {
        upsert: async (rows: any[], opts: { onConflict: string }) => {
          for (const r of rows) {
            const i = tables[t].findIndex((x) => keyOf(t, opts.onConflict, x) === keyOf(t, opts.onConflict, r));
            if (i >= 0) tables[t][i] = { ...tables[t][i], ...r }; else tables[t].push({ ...r });
          }
          return { error: null };
        },
        select: (_cols: string) => {
          let rows = tables[t];
          const q: any = { eq: (c: string, v: any) => { rows = rows.filter((r) => r[c] === v); return q; }, then: (res: any) => res({ data: rows, error: null }) };
          return q;
        },
      };
    },
  } as any;
}

const provider = (dataChecked: boolean): DataProvider => ({
  name: "stub",
  fetchStatic: async () => ({
    teams: [{ id: 1, name: "Arsenal", short_name: "ARS", code: 3 }, { id: 2, name: "Man City", short_name: "MCI", code: 43 }],
    players: [{ id: 10, web_name: "Saka", first_name: null, second_name: null, team_id: 1, position: "MID", status: "a", news: null, now_cost: 100 }],
    gameweeks: [
      { id: 1, name: "GW1", deadline_at: "2026-08-21T17:30:00Z", finished: dataChecked, data_checked: dataChecked },
      { id: 2, name: "GW2", deadline_at: "2099-01-01T00:00:00Z", finished: false, data_checked: false },
    ],
  }),
  fetchFixtures: async () => [
    { id: 1, gameweek_id: 1, home_team_id: 1, away_team_id: 2, kickoff_at: "2026-08-21T19:00:00Z", started: true, finished: true, home_score: 1, away_score: 0 },
    { id: 2, gameweek_id: 1, home_team_id: 2, away_team_id: 1, kickoff_at: "2026-08-22T14:00:00Z", started: true, finished: true, home_score: 0, away_score: 0 },
    { id: 3, gameweek_id: 2, home_team_id: 1, away_team_id: 2, kickoff_at: null, started: false, finished: false, home_score: null, away_score: null },
  ],
  fetchLive: async (gw) => gw === 1
    ? [{ player_id: 10, points: dataChecked ? 9 : 7, minutes: 90, breakdown: [] }, { player_id: 999, points: 1, minutes: 1, breakdown: [] }]
    : [],
});

describe("jobs", () => {
  it("ingest loads reference data and tags gameweeks with their month", async () => {
    const db = fakeDb();
    const r = await runIngest(db, provider(false));
    expect(r).toEqual({ teams: 2, players: 1, gameweeks: 2, fixtures: 3 });
    expect(db.tables.gameweeks.find((g: any) => g.id === 1)).toMatchObject({ first_kickoff: "2026-08-21T19:00:00Z", month_key: "2026-08" });
    // GW2 has no kickoff yet, so it falls back to its deadline month
    expect(db.tables.gameweeks.find((g: any) => g.id === 2).month_key).toBe("2099-01");
  });

  it("live job updates locked gameweeks as provisional, skips future ones and unknown players", async () => {
    const db = fakeDb();
    await runIngest(db, provider(false));
    const r = await runLive(db, provider(false), new Date("2026-08-22T20:00:00Z"));
    expect(r.refreshed).toEqual({ 1: 1 });
    expect(db.tables.player_gw_points).toHaveLength(1);
    expect(db.tables.player_gw_points[0]).toMatchObject({ player_id: 10, gameweek_id: 1, points: 7, provisional: true });
  });

  it("when the feed confirms bonus points, one last fetch makes the rows final and polling stops", async () => {
    const db = fakeDb();
    await runIngest(db, provider(false));
    await runLive(db, provider(false), new Date("2026-08-22T20:00:00Z"));
    const r2 = await runLive(db, provider(true), new Date("2026-08-23T12:00:00Z"));
    expect(r2.refreshed).toEqual({ 1: 1 });
    expect(db.tables.player_gw_points[0]).toMatchObject({ points: 9, provisional: false });
    const r3 = await runLive(db, provider(true), new Date("2026-08-24T12:00:00Z"));
    expect(r3.refreshed).toEqual({});
  });
});
