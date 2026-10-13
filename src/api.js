// Every call the website makes to the database lives in this one file.
import { createClient } from "@supabase/supabase-js";

// The project URL and the anon (public) key are designed to be visible in a website: the database rules
// (row level security) are what protect the data. NEVER put the service_role key here.
const URL = import.meta.env.VITE_SUPABASE_URL || "https://bbfwfpinumpzcpchrocp.supabase.co";
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJiZndmcGludW1wemNwY2hyb2NwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4ODkzNzIsImV4cCI6MjEwNzQ2NTM3Mn0.h1BkfTWxBkzZOw0uFt88GP6ZRI70zFKB265NAYtzJLc";

const sb = createClient(URL, ANON);
const ok = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };

// Supabase returns at most 1000 rows per request, so read big tables in pages.
async function all(table, cols = "*", build = (q) => q) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const rows = ok(await build(sb.from(table).select(cols)).range(from, from + size - 1));
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

const api = {
  /* ---------- sign in / out ---------- */
  onAuth(cb) {
    // Called with the current session straight away, then on every sign-in or sign-out.
    sb.auth.getSession().then(({ data }) => cb(data.session ? { id: data.session.user.id, email: data.session.user.email } : null));
    const { data } = sb.auth.onAuthStateChange((_e, session) => {
      setTimeout(() => cb(session ? { id: session.user.id, email: session.user.email } : null), 0); // avoid calling the database inside this callback
    });
    return () => data.subscription.unsubscribe();
  },
  async signUp({ email, password, username }) {
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
    if (error) return { error: error.message };
    return { needsConfirm: !data.session };
  },
  async signIn({ email, password }) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    return { error: error ? error.message : null };
  },
  signOut: () => sb.auth.signOut(),
  async usernameTaken(username) {
    const rows = ok(await sb.from("profiles").select("id").eq("username", username).limit(1));
    return rows.length > 0;
  },
  async getProfile(id) {
    const rows = ok(await sb.from("profiles").select("id, username, created_at").eq("id", id).limit(1));
    return rows[0] || null;
  },

  /* ---------- football data (public) ---------- */
  async loadStatic() {
    const [teams, players, gameweeks, fixtures] = await Promise.all([
      all("teams"), all("players"), all("gameweeks", "id, deadline_at, month_key", (q) => q.order("id")), all("fixtures", "gameweek_id, home_team_id, away_team_id, kickoff_at"),
    ]);
    return { teams, players, gameweeks, fixtures };
  },

  /* ---------- my picks and leagues ---------- */
  async loadMine(uid) {
    const [p, lp] = await Promise.all([
      all("picks", "gameweek_id, player_id", (q) => q.eq("user_id", uid)),
      all("league_picks", "league_id, gameweek_id, player_id", (q) => q.eq("user_id", uid)),
    ]);
    const picks = {}; p.forEach((r) => { picks[r.gameweek_id] = r.player_id; });
    const lpicks = {}; lp.forEach((r) => { (lpicks[r.league_id] = lpicks[r.league_id] || {})[r.gameweek_id] = r.player_id; });
    return { picks, lpicks };
  },
  async savePick(uid, gw, pid) {
    ok(await sb.from("picks").upsert({ user_id: uid, gameweek_id: gw, player_id: pid }, { onConflict: "user_id,gameweek_id" }));
  },
  async clearPick(uid, gw) { ok(await sb.from("picks").delete().eq("user_id", uid).eq("gameweek_id", gw)); },
  async saveLeaguePick(uid, leagueId, gw, pid) {
    ok(await sb.from("league_picks").upsert({ league_id: leagueId, user_id: uid, gameweek_id: gw, player_id: pid }, { onConflict: "league_id,user_id,gameweek_id" }));
  },
  async clearLeaguePick(uid, leagueId, gw) {
    ok(await sb.from("league_picks").delete().eq("user_id", uid).eq("league_id", leagueId).eq("gameweek_id", gw));
  },

  async loadLeagues() {
    const ls = ok(await sb.from("leagues").select("id, code, name, owner_id, round_type, round_length, reset_picks").order("created_at"));
    const ms = ls.length ? ok(await sb.from("league_members").select("league_id, user_id")) : [];
    return ls.map((l) => ({
      id: l.id, code: l.code, name: l.name, owner: l.owner_id, reset: l.reset_picks,
      format: l.round_type === "gameweeks" ? { type: "gws", n: l.round_length } : { type: l.round_type },
      memberCount: ms.filter((m) => m.league_id === l.id).length,
    }));
  },
  async createLeague(name, format, reset) {
    const type = format.type === "gws" ? "gameweeks" : format.type;
    const l = ok(await sb.rpc("create_league", { p_name: name, p_round_type: type, p_round_length: format.type === "gws" ? format.n : null, p_reset: !!reset }));
    return l.code;
  },
  async joinLeague(code) { const l = ok(await sb.rpc("join_league", { p_code: code })); return l.name; },

  /* ---------- tables and points ---------- */
  async loadTable(leagueId) { return ok(await sb.rpc("gw_points_table", { p_league_id: leagueId || null })); },
  async loadMyPoints(playerIds) {
    if (!playerIds.length) return {};
    const rows = ok(await sb.from("player_gw_points").select("player_id, gameweek_id, points, provisional, breakdown").in("player_id", playerIds));
    const out = {}; rows.forEach((r) => { out[r.player_id + "|" + r.gameweek_id] = { points: r.points, provisional: r.provisional, breakdown: r.breakdown || [] }; });
    return out;
  },
};

export default api;
