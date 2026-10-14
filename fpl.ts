import type { BreakdownItem, DataProvider, Fixture, LivePoints, Player, Position, StaticData, Team, Gameweek } from "../types.js";

// The public Fantasy Premier League feed. It is unofficial and undocumented, so everything that touches its
// raw shape lives in this one file. If it changes (or you move to a licensed provider), only this file changes.
const BASE = "https://fantasy.premierleague.com/api";

const POSITIONS: Record<number, Position> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

const LABELS: Record<string, string> = {
  minutes: "Minutes played", goals_scored: "Goals", assists: "Assists", clean_sheets: "Clean sheet",
  goals_conceded: "Goals conceded", own_goals: "Own goals", penalties_saved: "Penalties saved",
  penalties_missed: "Penalties missed", yellow_cards: "Yellow cards", red_cards: "Red card",
  saves: "Saves", bonus: "Bonus points", defensive_contribution: "Defensive contribution",
};

/* ---------- pure mapping functions (unit-tested against sample payloads) ---------- */

export function mapStatic(json: any): StaticData {
  const teams: Team[] = (json.teams ?? []).map((t: any) => ({ id: t.id, name: t.name, short_name: t.short_name, code: t.code ?? null }));
  const players: Player[] = (json.elements ?? [])
    .filter((e: any) => POSITIONS[e.element_type])
    .map((e: any) => ({
      id: e.id, web_name: e.web_name, first_name: e.first_name ?? null, second_name: e.second_name ?? null,
      team_id: e.team, position: POSITIONS[e.element_type], status: e.status ?? "a",
      news: e.news ? String(e.news) : null, now_cost: e.now_cost ?? null,
      total_points: Number(e.total_points) || 0, form: Number(e.form) || 0,
    }));
  const gameweeks: Gameweek[] = (json.events ?? []).map((ev: any) => ({
    id: ev.id, name: ev.name, deadline_at: ev.deadline_time, finished: !!ev.finished, data_checked: !!ev.data_checked,
  }));
  return { teams, players, gameweeks };
}

export function mapFixtures(json: any[]): Fixture[] {
  return json.map((f) => ({
    id: f.id, gameweek_id: f.event ?? null, home_team_id: f.team_h, away_team_id: f.team_a,
    kickoff_at: f.kickoff_time ?? null, started: !!f.started, finished: !!(f.finished || f.finished_provisional),
    home_score: f.team_h_score ?? null, away_score: f.team_a_score ?? null,
  }));
}

export function mapLive(json: any): LivePoints[] {
  return (json.elements ?? []).map((el: any) => {
    const totals = new Map<string, { value: number; points: number }>();
    for (const fx of el.explain ?? []) {
      for (const s of fx.stats ?? []) {
        const cur = totals.get(s.identifier) ?? { value: 0, points: 0 };
        cur.value += s.value ?? 0; cur.points += s.points ?? 0; // double gameweeks: add both matches together
        totals.set(s.identifier, cur);
      }
    }
    const breakdown: BreakdownItem[] = [...totals.entries()]
      .filter(([, v]) => v.points !== 0)
      .map(([id, v]) => ({ label: LABELS[id] ?? id.replace(/_/g, " "), value: v.value, points: v.points }));
    const points: number = el.stats?.total_points ?? breakdown.reduce((n, b) => n + b.points, 0);
    const explained = breakdown.reduce((n, b) => n + b.points, 0);
    if (explained !== points) breakdown.push({ label: "Other", value: 0, points: points - explained });
    return { player_id: el.id, points, minutes: el.stats?.minutes ?? 0, breakdown };
  });
}

/* ---------- network ---------- */

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": "onepick-prototype/0.1" } });
  if (!res.ok) throw new Error(`FPL feed ${path} returned HTTP ${res.status}`);
  return res.json();
}

export const fplProvider: DataProvider = {
  name: "fpl",
  fetchStatic: async () => mapStatic(await get("/bootstrap-static/")),
  fetchFixtures: async () => mapFixtures(await get("/fixtures/")),
  fetchLive: async (gw) => mapLive(await get(`/event/${gw}/live/`)),
};
