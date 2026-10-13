import { describe, it, expect } from "vitest";
import { mapStatic, mapFixtures, mapLive } from "../src/providers/fpl";
import { monthKey } from "../src/month";

describe("FPL mapping", () => {
  it("maps bootstrap-static", () => {
    const r = mapStatic({
      teams: [{ id: 13, name: "Man City", short_name: "MCI", code: 43 }],
      elements: [
        { id: 411, web_name: "Haaland", first_name: "Erling", second_name: "Haaland", team: 13, element_type: 4, status: "a", news: "", now_cost: 150 },
        { id: 1, web_name: "Mystery", team: 13, element_type: 9 },
      ],
      events: [{ id: 1, name: "Gameweek 1", deadline_time: "2026-08-21T17:30:00Z", finished: false, data_checked: false }],
    });
    expect(r.players).toHaveLength(1);
    expect(r.players[0]).toMatchObject({ id: 411, position: "FWD", team_id: 13, news: null });
    expect(r.gameweeks[0].deadline_at).toBe("2026-08-21T17:30:00Z");
  });

  it("maps fixtures, including unscheduled ones", () => {
    const r = mapFixtures([
      { id: 1, event: 1, team_h: 1, team_a: 2, kickoff_time: "2026-08-21T19:00:00Z", started: true, finished: false, team_h_score: 1, team_a_score: 0 },
      { id: 2, event: null, team_h: 3, team_a: 4, kickoff_time: null },
    ]);
    expect(r[0]).toMatchObject({ gameweek_id: 1, started: true, home_score: 1 });
    expect(r[1]).toMatchObject({ gameweek_id: null, kickoff_at: null, finished: false });
  });

  it("builds a point breakdown that sums to the total", () => {
    const [p] = mapLive({ elements: [{
      id: 411, stats: { minutes: 90, total_points: 12 },
      explain: [{ fixture: 1, stats: [
        { identifier: "minutes", points: 2, value: 90 },
        { identifier: "goals_scored", points: 8, value: 2 },
        { identifier: "bonus", points: 2, value: 2 },
        { identifier: "yellow_cards", points: 0, value: 0 },
      ] }],
    }] });
    expect(p.points).toBe(12);
    expect(p.breakdown.map((b) => b.label)).toEqual(["Minutes played", "Goals", "Bonus points"]);
    expect(p.breakdown.reduce((n, b) => n + b.points, 0)).toBe(12);
  });

  it("adds both matches together in a double gameweek", () => {
    const [p] = mapLive({ elements: [{
      id: 5, stats: { minutes: 180, total_points: 9 },
      explain: [
        { fixture: 1, stats: [{ identifier: "minutes", points: 2, value: 90 }, { identifier: "assists", points: 3, value: 1 }] },
        { fixture: 2, stats: [{ identifier: "minutes", points: 2, value: 90 }, { identifier: "clean_sheets", points: 2, value: 1 }] },
      ],
    }] });
    expect(p.breakdown.find((b) => b.label === "Minutes played")).toMatchObject({ value: 180, points: 4 });
    expect(p.points).toBe(9);
  });

  it("keeps a player who did not play at zero, and flags unexplained points", () => {
    const r = mapLive({ elements: [
      { id: 7, stats: { minutes: 0, total_points: 0 }, explain: [] },
      { id: 8, stats: { minutes: 90, total_points: 5 }, explain: [{ fixture: 1, stats: [{ identifier: "minutes", points: 2, value: 90 }] }] },
    ] });
    expect(r[0]).toMatchObject({ points: 0, breakdown: [] });
    expect(r[1].breakdown.at(-1)).toMatchObject({ label: "Other", points: 3 });
  });
});

describe("monthKey", () => {
  it("uses UK time, so a late 31 Aug kickoff in BST lands in September", () => {
    expect(monthKey("2026-08-31T23:30:00Z")).toBe("2026-09");
    expect(monthKey("2026-08-31T22:30:00Z")).toBe("2026-08");
  });
});
