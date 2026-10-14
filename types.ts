// Provider-neutral shapes. Every data source maps into these, so the rest of the code never sees raw feed formats.
export type Position = "GK" | "DEF" | "MID" | "FWD";

export interface Team { id: number; name: string; short_name: string; code: number | null }
export interface Player {
  id: number; web_name: string; first_name: string | null; second_name: string | null;
  team_id: number; position: Position; status: string; news: string | null; now_cost: number | null;
  total_points: number; form: number;
}
export interface Gameweek {
  id: number; name: string; deadline_at: string; finished: boolean; data_checked: boolean;
}
export interface Fixture {
  id: number; gameweek_id: number | null; home_team_id: number; away_team_id: number;
  kickoff_at: string | null; started: boolean; finished: boolean; home_score: number | null; away_score: number | null;
}
export interface BreakdownItem { label: string; value: number; points: number }
export interface LivePoints { player_id: number; points: number; minutes: number; breakdown: BreakdownItem[] }

export interface StaticData { teams: Team[]; players: Player[]; gameweeks: Gameweek[] }

export interface DataProvider {
  name: string;
  fetchStatic(): Promise<StaticData>;
  fetchFixtures(): Promise<Fixture[]>;
  fetchLive(gameweek: number): Promise<LivePoints[]>;
}
