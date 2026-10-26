import { useState, useEffect, useMemo } from "react";
import api from "./api.js";
import { CRESTS } from "./crests.js";
import {
  Trophy, Users, Lock, Check, Search, LogOut, Plus, Info,
  Crown, Shield, ChevronRight, RotateCcw, Flame, Calendar, ChevronDown
} from "lucide-react";

/* ============================================================
   ONEPICK — Premier League, one player a week, use each once.
   A Champagne Sports game.
   ============================================================ */
const APP_NAME = "OnePick";
const COMPANY = "Champagne Sports";
const TAGLINE = "One pick a week. Make it count.";
const SUBTAGLINE = "Pick one Premier League player every gameweek. Use each one once a month. Highest total wins.";
const TOTAL_GWS = 38;

/* Rotating lines on the pick screen. */
const NO_PICK_LINES = [
  "Who's your pick? Make the call, gaffer.",
  "Back your judgement.",
  "Your pick won't make itself.",
  "Trust your eye.",
];
const LOCKED_LINES = [
  "Locked in. Your call, gaffer.",
  "That's your pick. Stand by it.",
  "No take-backs.",
];

/* ---- Reference data. Loaded once from the database at start-up, then read directly everywhere. ---- */
const PL_POOL = [];        // [{id, name, team, pos, rating}]
const BY_ID = {};
const FIXTURES = [];       // [gameweek, homeShort, awayShort, kickoff (UTC ISO)]
const TEAM_LIST = [];      // club names, A to Z
const TEAM_BY_SHORT = {};  // "ARS" -> "Arsenal"
const GAMEWEEKS = [];      // [{id, deadline_at}]
const MONTHS = [];         // [{key, label, short, gws}]  one entry per month, in order
const lineFor = (arr, seed) => arr[seed % arr.length];

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const ratingFromCost = (c) => (c == null ? 3 : c >= 110 ? 5 : c >= 85 ? 4 : c >= 65 ? 3 : c >= 50 ? 2 : 1);

function hydrate({ teams, players, gameweeks, fixtures }) {
  PL_POOL.length = 0; FIXTURES.length = 0; TEAM_LIST.length = 0; GAMEWEEKS.length = 0; MONTHS.length = 0;
  Object.keys(BY_ID).forEach((k) => delete BY_ID[k]);
  Object.keys(TEAM_BY_SHORT).forEach((k) => delete TEAM_BY_SHORT[k]);
  const nameById = {}, shortById = {};
  teams.forEach((t) => { nameById[t.id] = t.name; shortById[t.id] = t.short_name; TEAM_BY_SHORT[t.short_name] = t.name; TEAM_LIST.push(t.name); });
  TEAM_LIST.sort();
  players.filter((p) => p.active !== false && nameById[p.team_id]).forEach((p) => {
    const o = { id: p.id, name: p.web_name, team: nameById[p.team_id], pos: p.position, rating: ratingFromCost(p.now_cost), pts: Number(p.total_points) || 0, form: Number(p.form) || 0 };
    PL_POOL.push(o); BY_ID[o.id] = o;
  });
  PL_POOL.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  [...gameweeks].sort((a, b) => a.id - b.id).forEach((g) => {
    GAMEWEEKS.push({ id: g.id, deadline_at: g.deadline_at });
    const key = g.month_key || g.deadline_at.slice(0, 7);
    const last = MONTHS[MONTHS.length - 1];
    if (last && last.key === key) last.gws.push(g.id);
    else {
      const label = MONTH_LABEL.format(new Date(key + "-15T12:00:00Z"));
      MONTHS.push({ key, label, short: label.split(" ")[0].slice(0, 3), gws: [g.id] });
    }
  });
  fixtures.filter((f) => f.gameweek_id != null && shortById[f.home_team_id] && shortById[f.away_team_id])
    .sort((a, b) => a.gameweek_id - b.gameweek_id || String(a.kickoff_at || "~").localeCompare(String(b.kickoff_at || "~")))
    .forEach((f) => FIXTURES.push([f.gameweek_id, shortById[f.home_team_id], shortById[f.away_team_id], f.kickoff_at]));
}

/* The open gameweek is the first one whose deadline is still in the future. */
const deadlineOf = (gw) => (GAMEWEEKS.find((g) => g.id === gw) || {}).deadline_at;
const isLocked = (gw, nowMs) => { const d = deadlineOf(gw); return !d || new Date(d).getTime() <= nowMs; };
function openGameweek(nowMs) {
  const g = GAMEWEEKS.find((x) => new Date(x.deadline_at).getTime() > nowMs);
  if (g) return { gw: g.id, over: false };
  return { gw: GAMEWEEKS.length ? GAMEWEEKS[GAMEWEEKS.length - 1].id : 1, over: true };
}
function untilDeadline(gw, nowMs) {
  const d = deadlineOf(gw); if (!d) return "";
  const ms = new Date(d).getTime() - nowMs; if (ms <= 0) return "Locked";
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (h >= 48) return Math.floor(h / 24) + " days left";
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

const friendlyError = (msg = "") => {
  if (/locked/i.test(msg)) return "That gameweek has locked. Picks close at the deadline.";
  if (/duplicate key/i.test(msg)) return "You've already used that player.";
  if (/row-level security/i.test(msg)) return "That isn't allowed right now.";
  if (/Invalid login/i.test(msg)) return "That email and password don't match.";
  if (/already registered/i.test(msg)) return "That email already has an account. Try logging in.";
  if (/password/i.test(msg) && /6/.test(msg)) return "Your password needs at least 6 characters.";
  return msg || "Something went wrong. Try again.";
};

const BG = "#F2F5FA", PANEL = "#FFFFFF", INK = "#0B1B33", MUTED = "#5A6B85", LINE = "#E1E7F0";
const DEEP = "#0A2342", BLUE = "#1F4E9C", VOLT = "#D9F63B";
const FONT = 'Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const HEAD = { fontWeight: 800, letterSpacing: "-0.025em" };
const SHADOW = "0 1px 2px rgba(16,38,28,0.06), 0 8px 24px rgba(16,38,28,0.07)";
const POS_CHIP = {
  GK: "bg-sky-100 text-sky-800",
  DEF: "bg-emerald-100 text-emerald-800",
  MID: "bg-amber-100 text-amber-800",
  FWD: "bg-rose-100 text-rose-800",
};
const PITCH = "repeating-linear-gradient(90deg, #0A2342 0 64px, #0C2A4E 64px 128px)";

function PosChip({ pos }) {
  return <span className={"text-[11px] font-bold px-1.5 py-0.5 rounded-md " + POS_CHIP[pos]}>{pos}</span>;
}

/* ---------------- Logo: OnePick wordmark (text only) ---------------- */
const LOGO_FONT = '"Arial Black", "Helvetica Neue", Arial, sans-serif';
function Logo({ h = 40, dark = false }) {
  const size = Math.round(h * 0.7);
  return (
    <span
      role="img"
      aria-label={APP_NAME}
      className="inline-block select-none whitespace-nowrap"
      style={{ fontFamily: LOGO_FONT, fontWeight: 900, fontSize: size, lineHeight: 1, letterSpacing: "-0.045em" }}
    >
      <span style={{ color: dark ? "#FFFFFF" : INK }}>One</span><span style={{ color: dark ? VOLT : BLUE }}>Pick</span>
    </span>
  );
}

/* ---------------- Landing page ---------------- */
function Landing({ onStart }) {
  const steps = [
    { icon: Check, t: "Make your pick", d: "Choose one Premier League player every gameweek. That's your whole team sheet." },
    { icon: Lock, t: "Once a month", d: "Once a player has been your pick, he's off the table until the 1st of next month. Then he's back." },
    { icon: Trophy, t: "Win the month", d: "Standard FPL scoring. A new winner every month, plus a season-long table for the long game." },
  ];
  const features = [
    { icon: Users, t: "Leagues with your mates", d: "Start a league, share the code, settle it on the table." },
    { icon: Calendar, t: "Every week, tracked", d: "See every pick you've made and what it scored." },
    { icon: Shield, t: "No peeking", d: "Rivals can't see your pick until the gameweek deadline." },
  ];
  const example = [
    { gw: 9, name: "Saka", team: "Arsenal", pos: "MID", pts: 11 },
    { gw: 10, name: "Palmer", team: "Chelsea", pos: "MID", pts: 9 },
    { gw: 11, name: "Haaland", team: "Man City", pos: "FWD", pts: 14 },
  ];
  return (
    <div className="min-h-screen overflow-x-hidden" style={{ background: BG, fontFamily: FONT, color: INK }}>
      <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b" style={{ borderColor: LINE }}>
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <Logo h={40} />
          <div className="flex items-center gap-2">
            <button onClick={() => onStart("login")} className="px-4 py-2 rounded-xl text-sm font-semibold hover:bg-black/5 transition-colors">Log in</button>
            <button onClick={() => onStart("signup")} className="px-4 py-2 rounded-xl text-sm font-bold text-white hover:brightness-110 transition" style={{ background: BLUE }}>Play free</button>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden text-white" style={{ background: PITCH }}>
        <svg className="absolute -right-28 -bottom-36 opacity-10 pointer-events-none" width="520" height="520" viewBox="0 0 200 200" fill="none" stroke="#fff" strokeWidth="1.5" aria-hidden="true">
          <circle cx="100" cy="100" r="60" /><circle cx="100" cy="100" r="3" fill="#fff" /><path d="M0 100H200" />
        </svg>
        <div className="relative max-w-5xl mx-auto px-4 py-14 sm:py-20 grid md:grid-cols-2 gap-10 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-5" style={{ background: "rgba(255,255,255,0.1)" }}>
              <span className="w-2 h-2 rounded-full" style={{ background: VOLT }} /> Premier League · 2026/27 · Free to play
            </div>
            <h1 className="text-5xl sm:text-6xl leading-[1.02] mb-4" style={HEAD}>
              One pick a week. <span style={{ color: VOLT }}>Make it count.</span>
            </h1>
            <p className="text-lg mb-7 max-w-md" style={{ color: "rgba(255,255,255,0.82)" }}>
              Choose one Premier League player every gameweek. Use each one once a month, then they come back. A new winner every month.
            </p>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => onStart("signup")} className="px-6 py-3 rounded-xl font-bold hover:brightness-95 transition" style={{ background: VOLT, color: INK }}>
                Make your first pick
              </button>
              <button onClick={() => onStart("login")} className="px-6 py-3 rounded-xl font-semibold border border-white/30 hover:bg-white/10 transition-colors">
                I have an account
              </button>
            </div>
            <p className="text-xs mt-5" style={{ color: "rgba(255,255,255,0.6)" }}>{PL_POOL.length} players · all 20 clubs · free to play</p>
          </div>

          <div className="rounded-2xl bg-white p-5 text-left" style={{ boxShadow: "0 24px 60px rgba(0,0,0,0.35)", color: INK }}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-semibold" style={{ color: MUTED }}>YOUR SEASON <span className="font-normal">· example</span></div>
              <div className="text-xs font-bold px-2 py-1 rounded-md" style={{ background: "rgba(31,78,156,0.12)", color: BLUE }}>GW12</div>
            </div>
            {example.map((r) => (
              <div key={r.gw} className="flex items-center gap-3 py-2.5 border-b" style={{ borderColor: LINE }}>
                <div className="w-8 text-sm font-bold tabular-nums" style={{ color: MUTED }}>{r.gw}</div>
                <Crest team={r.team} size={28} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold leading-tight">{r.name}</div>
                  <div className="text-xs" style={{ color: MUTED }}>{r.team}</div>
                </div>
                <PosChip pos={r.pos} />
                <div className="w-8 text-right font-extrabold tabular-nums" style={{ color: BLUE }}>{r.pts}</div>
              </div>
            ))}
            <div className="mt-3 flex items-center justify-between rounded-xl border-2 border-dashed px-3 py-3" style={{ borderColor: "#C5D0E0" }}>
              <div>
                <div className="text-xs font-semibold" style={{ color: MUTED }}>GW12</div>
                <div className="font-bold">Make your pick</div>
              </div>
              <span className="text-xs font-bold px-3 py-1.5 rounded-lg" style={{ background: VOLT, color: INK }}>Pick</span>
            </div>
          </div>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-4 py-14">
        <h2 className="text-3xl mb-1" style={HEAD}>How it works</h2>
        <p className="mb-7" style={{ color: MUTED }}>Three rules. That's the whole game.</p>
        <div className="grid sm:grid-cols-3 gap-4">
          {steps.map((st, i) => {
            const Icon = st.icon;
            return (
              <div key={i} className="rounded-2xl bg-white p-5 border" style={{ borderColor: LINE, boxShadow: SHADOW }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: "rgba(31,78,156,0.12)", color: BLUE }}><Icon size={20} /></div>
                <div className="text-lg font-bold mb-1" style={{ letterSpacing: "-0.01em" }}>{st.t}</div>
                <div className="text-sm leading-relaxed" style={{ color: MUTED }}>{st.d}</div>
              </div>
            );
          })}
        </div>

        <div className="grid sm:grid-cols-3 gap-6 mt-12">
          {features.map((f, i) => {
            const Icon = f.icon;
            return (
              <div key={i} className="flex gap-3">
                <div className="shrink-0 mt-0.5" style={{ color: BLUE }}><Icon size={20} /></div>
                <div>
                  <div className="font-bold">{f.t}</div>
                  <div className="text-sm" style={{ color: MUTED }}>{f.d}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-12 rounded-2xl p-7 sm:p-9 flex flex-wrap items-center justify-between gap-4 text-white" style={{ background: PITCH }}>
          <div>
            <div className="text-2xl" style={HEAD}>Think you've got the eye of a gaffer?</div>
            <div style={{ color: "rgba(255,255,255,0.75)" }}>Back your judgement. 38 weeks, 38 different picks.</div>
          </div>
          <button onClick={() => onStart("signup")} className="px-6 py-3 rounded-xl font-bold hover:brightness-95 transition" style={{ background: VOLT, color: INK }}>
            Make your first pick
          </button>
        </div>
      </section>

      <footer className="text-center text-xs pb-8" style={{ color: MUTED }}>
        {APP_NAME} is a {COMPANY} game
      </footer>
    </div>
  );
}

function Centered({ children }) {
  return <div className="min-h-screen flex items-center justify-center p-6 text-center" style={{ background: BG, fontFamily: FONT, color: INK }}><div className="max-w-sm">{children}</div></div>;
}

export default function App() {
  const [boot, setBoot] = useState({ state: "loading" });   // loading | ready | empty | error
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState(null);                   // {id, email, username}
  const [authMode, setAuthMode] = useState(null);           // null = show landing page
  const [tab, setTab] = useState("pick");
  const [now, setNow] = useState(Date.now());
  const [picks, setPicks] = useState({});                   // {gameweek: playerId}
  const [lpicks, setLpicks] = useState({});                 // {leagueId: {gameweek: playerId}}
  const [leagues, setLeagues] = useState([]);
  const [tables, setTables] = useState({});                 // {main | leagueId: rows from gw_points_table}
  const [myPts, setMyPts] = useState({});                   // {"playerId|gameweek": {points, provisional, breakdown}}
  const [toast, setToast] = useState("");
  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 4500); };

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const data = await api.loadStatic();
        if (off) return;
        hydrate(data);
        setBoot({ state: PL_POOL.length && GAMEWEEKS.length ? "ready" : "empty" });
      } catch (e) { if (!off) setBoot({ state: "error", msg: e.message }); }
    })();
    const unsub = api.onAuth(async (sess) => {
      if (!sess) { setUser(null); setAuthChecked(true); return; }
      let prof = null;
      try { prof = await api.getProfile(sess.id); } catch {}
      setUser({ id: sess.id, email: sess.email, username: (prof && prof.username) || sess.email, joined: prof && prof.created_at ? new Date(prof.created_at).getTime() : 0 });
      setAuthChecked(true);
    });
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => { off = true; if (unsub) unsub(); clearInterval(tick); };
  }, []);

  const refresh = async () => {
    if (!user) return;
    try {
      const [mine, lgs] = await Promise.all([api.loadMine(user.id), api.loadLeagues()]);
      setPicks(mine.picks); setLpicks(mine.lpicks); setLeagues(lgs);
      const keys = [null, ...lgs.map((l) => l.id)];
      const rows = await Promise.all(keys.map((k) => api.loadTable(k)));
      setTables(Object.fromEntries(keys.map((k, i) => [k || "main", rows[i]])));
      const ids = [...new Set([...Object.values(mine.picks), ...Object.values(mine.lpicks).flatMap((o) => Object.values(o))])];
      setMyPts(await api.loadMyPoints(ids));
    } catch (e) { flash(friendlyError(e.message)); }
  };
  useEffect(() => {
    if (!user) { setPicks({}); setLpicks({}); setLeagues([]); setTables({}); setMyPts({}); return; }
    refresh();
    const t = setInterval(refresh, 120000);
    return () => clearInterval(t);
  }, [user && user.id]);

  if (boot.state === "loading" || !authChecked)
    return <Centered><div className="animate-pulse text-sm" style={{ color: MUTED }}>Loading {APP_NAME}…</div></Centered>;
  if (boot.state === "error")
    return <Centered><Logo h={48} /><p className="mt-4 font-semibold">Can't reach the game just now.</p>
      <p className="text-sm mt-1" style={{ color: MUTED }}>{boot.msg}</p>
      <button onClick={() => window.location.reload()} className="mt-4 px-4 py-2 rounded-xl text-white font-bold" style={{ background: BLUE }}>Try again</button></Centered>;
  if (boot.state === "empty")
    return <Centered><Logo h={48} /><p className="mt-4 font-semibold">The player list hasn't been loaded yet.</p>
      <p className="text-sm mt-1" style={{ color: MUTED }}>The nightly job needs to run once. In GitHub, open Actions, choose "Nightly ingest", then Run workflow.</p></Centered>;

  const doSignUp = async ({ email, password, username }) => {
    try {
      if (await api.usernameTaken(username)) return "That username is taken.";
      const r = await api.signUp({ email, password, username });
      if (r.error) return friendlyError(r.error);
      return r.needsConfirm ? "CONFIRM" : null;
    } catch (e) { return friendlyError(e.message); }
  };
  const doLogin = async (cred) => { try { const r = await api.signIn(cred); return r.error ? friendlyError(r.error) : null; } catch (e) { return friendlyError(e.message); } };

  if (!user) {
    if (!authMode) return <Landing onStart={(m) => setAuthMode(m)} />;
    return <AuthScreen initialMode={authMode} onBack={() => setAuthMode(null)} onSignUp={doSignUp} onLogin={doLogin} />;
  }

  const { gw: currentGW, over } = openGameweek(now);
  const nowMs = now;
  const usedIds = new Set(Object.values(picks));
  const closed = over || isLocked(currentGW, nowMs);

  const mainRows = tables.main || [];
  const official = leagues.find((l) => l.official) || null;
  const officialRows = official ? (tables[official.id] || []) : null;
  const curMonth = MONTHS.find((m) => m.gws.includes(currentGW));
  const headRows = officialRows || mainRows;
  const headGws = officialRows && curMonth ? new Set(curMonth.gws) : null;
  const mainBoard = (() => {
    const t = new Map();
    headRows.forEach((r) => { if (!headGws || r.gameweek_id == null || headGws.has(r.gameweek_id)) t.set(r.user_id, (t.get(r.user_id) || 0) + (r.points || 0)); else if (!t.has(r.user_id)) t.set(r.user_id, 0); });
    return [...t.entries()].map(([id, total]) => ({ id, total }));
  })();
  const myTotal = mainBoard.find((r) => r.id === user.id)?.total || 0;
  const myRank = 1 + mainBoard.filter((r) => r.total > myTotal).length;

  const guard = () => { if (closed) { flash("Picks are closed. The deadline has passed."); return false; } return true; };
  const pickPlayer = async (pid) => {
    if (!guard()) return;
    if (usedIds.has(pid) && picks[currentGW] !== pid) return;
    try {
      if (picks[currentGW] === pid) { await api.clearPick(user.id, currentGW); const n = { ...picks }; delete n[currentGW]; setPicks(n); }
      else { await api.savePick(user.id, currentGW, pid); setPicks({ ...picks, [currentGW]: pid }); }
    } catch (e) { flash(friendlyError(e.message)); }
  };

  const resetLeagues = leagues.filter((l) => l.reset && l.format.type !== "season" && !l.official);
  const privateLeagues = leagues.filter((l) => !l.official);
  const roundOf = (lg) => roundsFor(lg.format).find((r) => r.gws.includes(currentGW)) || { gws: [currentGW], label: "GW" + currentGW };
  const pickForLeague = (lg) => async (pid) => {
    if (!guard()) return;
    const mine = { ...(lpicks[lg.id] || {}) }; const gws = roundOf(lg).gws;
    if (gws.filter((g) => g !== currentGW).map((g) => mine[g]).includes(pid)) return;
    try {
      if (mine[currentGW] === pid) { await api.clearLeaguePick(user.id, lg.id, currentGW); delete mine[currentGW]; }
      else { await api.saveLeaguePick(user.id, lg.id, currentGW, pid); mine[currentGW] = pid; }
      setLpicks({ ...lpicks, [lg.id]: mine });
    } catch (e) { flash(friendlyError(e.message)); }
  };
  const leagueCtx = (lg, label, sub) => {
    const mine = lpicks[lg.id] || {}; const r = roundOf(lg);
    const roundMine = Object.fromEntries(Object.entries(mine).filter(([g]) => r.gws.includes(Number(g))));
    return { id: lg.id, label: label || lg.name, sub: sub || "Resets after " + r.label, usedIds: new Set(Object.values(roundMine)), myPick: mine[currentGW], myPicks: roundMine, onPick: pickForLeague(lg),
      progress: { label: lg.official ? "Used this month (" + r.label + ")" : "Used this round (" + r.label + ")", used: Object.keys(roundMine).length, total: r.gws.length } };
  };
  const ctxs = [
    ...(official ? [leagueCtx(official, "OnePick Monthly", "Players come back each month")] : []),
    { id: "main", label: official ? "OnePick Season" : "Main game", sub: "No repeats all season", usedIds, myPick: picks[currentGW], myPicks: picks, onPick: pickPlayer, progress: { label: "Picks used", used: usedIds.size, total: TOTAL_GWS } },
    ...resetLeagues.map((lg) => leagueCtx(lg)),
  ];

  const logout = async () => { await api.signOut(); setAuthMode(null); setTab("pick"); };
  const createLeague = async (name, format, reset) => { const code = await api.createLeague(name, format, reset); await refresh(); return code; };
  const joinLeague = async (code) => {
    try { await api.joinLeague(code); await refresh(); return ""; } catch (e) { return /No league/i.test(e.message) ? "No league found with that code." : friendlyError(e.message); }
  };

  const tabs = [{ id: "pick", label: "Pick", icon: Check }, { id: "season", label: "My picks", icon: Calendar }, { id: "leagues", label: "Leagues", icon: Users }, { id: "rules", label: "Rules", icon: Info }];

  return (
    <div className="min-h-screen" style={{ background: BG, fontFamily: FONT, color: INK }}>
      <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b" style={{ borderColor: LINE }}>
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Logo h={40} />
            <div className="hidden sm:block text-xs leading-snug border-l pl-3" style={{ borderColor: LINE, color: MUTED }}>Premier League<br />Gameweek {currentGW}</div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-baseline gap-1.5 rounded-xl px-3 py-1.5" style={{ background: "rgba(31,78,156,0.1)" }}>
              <span className="text-xl font-extrabold tabular-nums leading-none" style={{ color: BLUE }}>{myTotal}</span>
              <span className="text-[11px] font-medium" style={{ color: MUTED }}>pts{officialRows && curMonth ? " in " + curMonth.short : ""} · #{myRank} of {Math.max(mainBoard.length, 1)}</span>
            </div>
            <div className="hidden sm:block text-sm font-medium">{user.username}</div>
            <button onClick={logout} title="Log out" className="p-2 rounded-lg hover:bg-black/5 transition-colors" style={{ color: MUTED }}><LogOut size={18} /></button>
          </div>
        </div>
        <nav className="max-w-5xl mx-auto px-4 pb-3 flex gap-2 overflow-x-auto">
          {tabs.map((t) => {
            const Icon = t.icon, active = tab === t.id;
            return <button key={t.id} onClick={() => setTab(t.id)}
              className={"flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors " + (active ? "text-white" : "hover:bg-black/5")}
              style={active ? { background: DEEP } : { color: MUTED }}>
              <Icon size={15} /> {t.label}</button>;
          })}
        </nav>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {tab === "pick" && <PickView currentGW={currentGW} ctxs={ctxs} closed={closed} now={now} />}
        {tab === "season" && <MyPicksView official={official} picks={picks} lpicks={lpicks} currentGW={currentGW} pts={myPts} now={now} joined={user.joined} />}
        {tab === "leagues" && <LeaguesView myId={user.id} leagues={privateLeagues} official={official} tables={tables} picks={picks} lpicks={lpicks} currentGW={currentGW} onCreate={createLeague} onJoin={joinLeague} />}
        {tab === "rules" && <RulesView />}
      </main>

      <footer className="max-w-5xl mx-auto px-4 py-6 text-center text-xs" style={{ color: MUTED }}>
        {APP_NAME} is a {COMPANY} game · early prototype
      </footer>
      {toast && <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-50 max-w-sm px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-lg" style={{ background: "#BE123C" }} role="alert">{toast}</div>}
    </div>
  );
}

function AuthScreen({ onSignUp, onLogin, initialMode, onBack }) {
  const [mode, setMode] = useState(initialMode || "signup");
  const [email, setEmail] = useState(""); const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [sent, setSent] = useState(false);
  const submit = async () => {
    setErr("");
    const em = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(em)) return setErr("Enter a valid email address.");
    if (password.length < 6) return setErr("Your password needs at least 6 characters.");
    const u = username.trim();
    if (mode === "signup" && !/^[A-Za-z0-9_]{3,20}$/.test(u)) return setErr("Username: 3 to 20 letters, numbers or underscores.");
    setBusy(true);
    const res = mode === "signup" ? await onSignUp({ email: em, password, username: u }) : await onLogin({ email: em, password });
    setBusy(false);
    if (res === "CONFIRM") setSent(true); else if (res) setErr(res);
  };
  const input = "w-full mb-4 px-3.5 py-2.5 rounded-xl bg-white border focus:outline-none focus:ring-2";
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: BG, fontFamily: FONT, color: INK }}>
      <div className="w-full max-w-sm">
        <button onClick={onBack} className="text-sm mb-4 hover:opacity-70 transition-opacity" style={{ color: MUTED }}>← Back</button>
        <div className="flex flex-col items-center mb-5">
          <Logo h={64} />
          <p className="text-center text-sm mt-3" style={{ color: MUTED }}>{TAGLINE}</p>
        </div>
        <div className="rounded-2xl bg-white p-6 border" style={{ borderColor: LINE, boxShadow: SHADOW }}>
          {sent ? <div className="text-center py-4"><div className="font-bold mb-1">Check your email</div><div className="text-sm" style={{ color: MUTED }}>We've sent a link to confirm your account. Click it, then log in.</div></div> : <>
          <div className="flex rounded-xl p-1 mb-5" style={{ background: "#EEF2F8" }}>
            {["signup", "login"].map((m) => <button key={m} onClick={() => { setMode(m); setErr(""); }}
              className={"flex-1 py-2 text-sm font-semibold rounded-lg transition-all " + (mode === m ? "bg-white shadow-sm" : "")}
              style={mode === m ? { color: INK } : { color: MUTED }}>{m === "signup" ? "Sign up" : "Log in"}</button>)}
          </div>
          <label className="block text-xs font-semibold mb-1" style={{ color: MUTED }}>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="you@example.com" autoComplete="email"
            className={input} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          {mode === "signup" && <>
            <label className="block text-xs font-semibold mb-1" style={{ color: MUTED }}>Username <span className="font-normal">(what your mates see)</span></label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="e.g. tactical_genius" autoComplete="username"
              className={input} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          </>}
          <label className="block text-xs font-semibold mb-1" style={{ color: MUTED }}>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="At least 6 characters" autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className={input} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          {err && <div className="text-sm mb-3 text-rose-600" role="alert">{err}</div>}
          <button onClick={submit} disabled={busy} className="w-full py-3 rounded-xl text-white font-bold hover:brightness-110 transition disabled:opacity-60" style={{ background: BLUE }}>{busy ? "One moment…" : mode === "signup" ? "Create account" : "Log in"}</button>
          </>}
        </div>
        <p className="text-center text-xs mt-4 leading-relaxed" style={{ color: MUTED }}>Early prototype. Your email is only used to log you in.</p>
      </div>
    </div>
  );
}

/* ---------------- Club crests + fixtures helpers ---------------- */
const POS_ORDER = ["FWD", "MID", "DEF", "GK"];
const POS_LABEL = { FWD: "Forwards", MID: "Midfielders", DEF: "Defenders", GK: "Goalkeepers" };
const UK_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" });
const UK_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const UK_WEEKDAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" });
const ukPart = (fmt, iso, type) => (fmt.formatToParts(new Date(iso)).find((x) => x.type === type) || {}).value || "";
const koDay = (iso) => `${ukPart(UK_DAY, iso, "weekday")} ${ukPart(UK_DAY, iso, "day")} ${ukPart(UK_DAY, iso, "month")}`;
const koTime = (iso) => `${ukPart(UK_TIME, iso, "hour")}:${ukPart(UK_TIME, iso, "minute")}`;
const koShort = (iso) => `${ukPart(UK_WEEKDAY, iso, "weekday")} ${koTime(iso)}`;

function Crest({ team, size = 28 }) {
  const badge = CRESTS[team];
  return (
    <span className="inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      {badge ? <img src={badge} alt="" draggable="false" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : null}
    </span>
  );
}

function FixtureRow({ f }) {
  const [, h, a, ko] = f;
  const hn = TEAM_BY_SHORT[h], an = TEAM_BY_SHORT[a];
  const name = (short, full, right) => (
    <span className={"text-xs md:text-sm font-semibold leading-tight " + (right ? "text-right" : "text-left")}>{full}</span>
  );
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl bg-white border px-2 md:px-3 py-2" style={{ borderColor: LINE }}>
      <div className="flex items-center justify-end gap-1.5 md:gap-2 min-w-0">{name(h, hn, true)}<Crest team={hn} size={24} /></div>
      <div className="text-xs font-bold tabular-nums px-2 py-1 rounded-md" style={{ background: "rgba(31,78,156,0.1)", color: BLUE }}>{ko ? koTime(ko) : "TBC"}</div>
      <div className="flex items-center gap-2 min-w-0"><Crest team={an} size={24} />{name(a, an, false)}</div>
    </div>
  );
}

function FixturesPanel({ gw, fixtures }) {
  const [open, setOpen] = useState(true);
  const days = useMemo(() => {
    const out = [];
    fixtures.forEach((f) => {
      const d = f[3] ? koDay(f[3]) : "Date to be confirmed";
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(f); else out.push({ day: d, items: [f] });
    });
    return out;
  }, [fixtures]);
  return (
    <div className="rounded-2xl bg-white border mb-5" style={{ borderColor: LINE, boxShadow: SHADOW }}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="flex items-center gap-2 font-bold"><Calendar size={16} style={{ color: BLUE }} /> Gameweek {gw} fixtures</span>
        <span className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
          {fixtures.length} {fixtures.length === 1 ? "match" : "matches"} · UK time
          <ChevronRight size={16} className={"transition-transform " + (open ? "rotate-90" : "")} />
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-3 border-t space-y-3" style={{ borderColor: LINE }}>
          {days.length === 0 && <div className="text-sm" style={{ color: MUTED }}>No fixtures scheduled for this gameweek.</div>}
          {days.map((d) => (
            <div key={d.day}>
              <div className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>{d.day}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{d.items.map((f, i) => <FixtureRow key={i} f={f} />)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FixtureLine({ fixtures }) {
  if (!fixtures.length) return <div className="text-xs mt-0.5 font-medium" style={{ color: "#B45309" }}>No fixture this week</div>;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs mt-0.5" style={{ color: MUTED }}>
      {fixtures.map((x, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <span className="font-semibold" style={{ color: INK }}>{x.home ? "v" : "@"}</span>
          <Crest team={TEAM_BY_SHORT[x.opp]} size={14} />
          <span className="font-semibold" style={{ color: INK }}>{x.opp}</span>
          <span>({x.home ? "H" : "A"}){x.ko ? ` · ${koShort(x.ko)}` : ""}</span>
        </span>
      ))}
    </div>
  );
}

function PlayerCard({ p, mine, selected, usedGw, onPick }) {
  const used = usedGw !== undefined && !mine;
  return (
    <button onClick={() => onPick(p.id)} disabled={used}
      className={"text-left rounded-xl border px-3 py-2.5 transition-all " + (used ? "opacity-50 cursor-not-allowed bg-slate-50" : "bg-white hover:-translate-y-px hover:shadow-md")}
      style={selected ? { borderColor: VOLT, borderWidth: 2, background: "rgba(217,246,59,0.22)" } : mine ? { borderColor: BLUE, borderWidth: 2, background: "rgba(31,78,156,0.06)" } : { borderColor: LINE }}>
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold truncate">{p.name}</div>
        <div className="shrink-0">
          {selected ? <span className="text-[11px] font-bold px-1.5 py-0.5 rounded" style={{ background: DEEP, color: VOLT }}>SELECTED</span> : mine ? <Check size={16} style={{ color: BLUE }} /> : used ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: MUTED }}><Lock size={12} /> GW{usedGw}</span>
          ) : (
            <div className="flex gap-0.5">{Array.from({ length: 5 }, (_, i) => <span key={i} className="w-1 h-3 rounded-sm" style={{ background: i < p.rating ? BLUE : "#DCE3EE" }} />)}</div>
          )}
        </div>
      </div>
    </button>
  );
}

function TeamRow({ team, players, open, onToggle, fixtures, myPick, sel, usedIds, gwUsed, onPick }) {
  const usedCount = players.filter((p) => usedIds.has(p.id) && p.id !== myPick).length;
  const hasMine = players.some((p) => p.id === myPick);
  const groups = POS_ORDER.map((pos) => [pos, players.filter((p) => p.pos === pos)]).filter(([, l]) => l.length);
  return (
    <div className="rounded-2xl bg-white overflow-hidden border" style={{ borderColor: hasMine ? BLUE : LINE, borderWidth: hasMine ? 2 : 1, boxShadow: open ? SHADOW : undefined }}>
      <button onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/5 transition-colors">
        <Crest team={team} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold">{team}</span>
            {hasMine && <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-md text-white" style={{ background: BLUE }}>Your pick</span>}
          </div>
          <FixtureLine fixtures={fixtures} />
        </div>
        <div className="text-right text-xs shrink-0" style={{ color: MUTED }}>
          <div className="font-semibold" style={{ color: INK }}>{players.length} {players.length === 1 ? "player" : "players"}</div>
          {usedCount > 0 && <div>{usedCount} used</div>}
        </div>
        <ChevronRight size={18} className={"shrink-0 transition-transform " + (open ? "rotate-90" : "")} style={{ color: MUTED }} />
      </button>
      {open && (
        <div className="border-t px-4 pb-4 pt-3 space-y-4" style={{ borderColor: LINE }}>
          {groups.map(([pos, list]) => (
            <div key={pos}>
              <div className="flex items-center gap-2 mb-2"><PosChip pos={pos} /><span className="text-xs font-semibold" style={{ color: MUTED }}>{POS_LABEL[pos]} · {list.length}</span></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {list.map((p) => <PlayerCard key={p.id} p={p} mine={myPick === p.id} selected={sel === p.id} usedGw={gwUsed[p.id]} onPick={onPick} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TopPicks({ fixByTeam, myPick, sel, usedIds, onPick, closed }) {
  const [by, setBy] = useState("pts");
  const hasData = useMemo(() => PL_POOL.some((p) => p.pts > 0), [PL_POOL.length]);
  const lists = useMemo(() => POS_ORDER.map((pos) => {
    const l = PL_POOL.filter((p) => p.pos === pos && (fixByTeam[p.team] || []).length && (!usedIds.has(p.id) || p.id === myPick))
      .sort((a, b) => b[by] - a[by] || b.pts - a.pts || a.name.localeCompare(b.name)).slice(0, 3);
    return [pos, l];
  }), [by, fixByTeam, usedIds, myPick, PL_POOL.length]);
  if (!hasData) return null;
  const tab = (k, label) => <button onClick={() => setBy(k)} className={"px-3 py-1 rounded-full text-xs font-semibold border transition-colors " + (by === k ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
    style={by === k ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>{label}</button>;
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div><div className="font-bold">Top 3 by position</div><div className="text-xs" style={{ color: MUTED }}>Players you haven't used yet, who play this gameweek</div></div>
        <div className="flex gap-1.5">{tab("pts", "Season points")}{tab("form", "Form")}</div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {lists.map(([pos, list]) => (
          <div key={pos} className="rounded-2xl bg-white border p-3" style={{ borderColor: LINE, boxShadow: SHADOW }}>
            <div className="flex items-center gap-2 mb-2"><PosChip pos={pos} /><span className="text-xs font-semibold" style={{ color: MUTED }}>{POS_LABEL[pos]}</span></div>
            <div className="space-y-1">
              {list.length === 0 && <div className="text-xs py-2" style={{ color: MUTED }}>No one available</div>}
              {list.map((p, i) => {
                const fx = (fixByTeam[p.team] || []).map((f) => f.opp + (f.home ? " (H)" : " (A)")).join(", ");
                const isSel = sel === p.id, mine = myPick === p.id;
                return (
                  <button key={p.id} onClick={() => onPick(p.id)} disabled={closed}
                    className="w-full flex items-center gap-2 text-left rounded-xl px-2 py-1.5 border transition-colors hover:bg-black/5 disabled:cursor-not-allowed"
                    style={isSel ? { borderColor: VOLT, borderWidth: 2, background: "rgba(217,246,59,0.22)" } : mine ? { borderColor: BLUE, borderWidth: 2, background: "rgba(31,78,156,0.06)" } : { borderColor: "transparent" }}>
                    <span className="w-4 text-xs font-bold tabular-nums" style={{ color: MUTED }}>{i + 1}</span>
                    <Crest team={p.team} size={24} />
                    <span className="min-w-0 flex-1"><span className="block text-sm font-semibold truncate">{p.name}</span><span className="block text-[11px] truncate" style={{ color: MUTED }}>v {fx}</span></span>
                    <span className="text-right shrink-0"><span className="block text-sm font-extrabold tabular-nums" style={{ color: BLUE }}>{by === "pts" ? p.pts : p.form.toFixed(1)}</span><span className="block text-[10px]" style={{ color: MUTED }}>{by === "pts" ? "pts" : "form"}</span></span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PickView({ currentGW, ctxs, closed, now }) {
  const [ctxId, setCtxId] = useState(null);
  const c = ctxs.find((x) => x.id === ctxId) || ctxs[0];
  const { usedIds, myPick, myPicks, onPick } = c;
  const [q, setQ] = useState(""); const [posFilter, setPosFilter] = useState("ALL"); const [teamFilter, setTeamFilter] = useState("ALL");
  const [open, setOpen] = useState(() => new Set());
  const [sel, setSel] = useState(null);
  useEffect(() => { setSel(null); }, [currentGW, c.id]);
  const choose = (id) => { if (closed) return; setSel((cur) => (cur === id || id === myPick ? null : id)); };
  const confirmPick = () => { if (sel) { onPick(sel); setSel(null); } };

  const gwUsed = useMemo(() => { const m = {}; Object.entries(myPicks).forEach(([gw, id]) => { m[id] = Number(gw); }); return m; }, [myPicks]);
  const gwFixtures = useMemo(() => FIXTURES.filter((f) => f[0] === currentGW), [currentGW]);
  const fixByTeam = useMemo(() => {
    const m = {};
    gwFixtures.forEach(([, h, a, ko]) => {
      const hn = TEAM_BY_SHORT[h], an = TEAM_BY_SHORT[a];
      (m[hn] = m[hn] || []).push({ opp: a, home: true, ko });
      (m[an] = m[an] || []).push({ opp: h, home: false, ko });
    });
    return m;
  }, [gwFixtures]);

  const byTeam = useMemo(() => {
    const s = q.trim().toLowerCase(); const m = {};
    PL_POOL.forEach((p) => {
      if (posFilter !== "ALL" && p.pos !== posFilter) return;
      if (teamFilter !== "ALL" && p.team !== teamFilter) return;
      if (s && !`${p.name} ${p.team}`.toLowerCase().includes(s)) return;
      (m[p.team] = m[p.team] || []).push(p);
    });
    return m;
  }, [q, posFilter, teamFilter]);
  const teamsShown = TEAM_LIST.filter((t) => byTeam[t] && byTeam[t].length);
  const totalShown = teamsShown.reduce((n, t) => n + byTeam[t].length, 0);

  // searching or choosing a club opens the matching clubs; clearing them folds everything away again
  useEffect(() => {
    const s = q.trim().toLowerCase();
    if (s) setOpen(new Set(PL_POOL.filter((p) => `${p.name} ${p.team}`.toLowerCase().includes(s)).map((p) => p.team)));
    else if (teamFilter !== "ALL") setOpen(new Set([teamFilter]));
    else setOpen(new Set());
  }, [q, teamFilter]);

  const toggle = (team) => setOpen((prev) => { const n = new Set(prev); if (n.has(team)) n.delete(team); else n.add(team); return n; });
  const picked = myPick ? BY_ID[myPick] : null;
  const pct = Math.min(100, Math.round((c.progress.used / c.progress.total) * 100));
  const field = "px-3 py-2.5 rounded-xl bg-white border text-sm focus:outline-none focus:ring-2";
  return (
    <div>
      {ctxs.length > 1 && (
        <div className="mb-3">
          <div className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>Picking for</div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {ctxs.map((x) => <button key={x.id} onClick={() => setCtxId(x.id)} className={"shrink-0 text-left rounded-xl border px-3 py-2 transition-colors " + (c.id === x.id ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
              style={c.id === x.id ? { background: DEEP } : { borderColor: LINE }}>
              <div className="text-sm font-bold">{x.label}</div>
              <div className="text-[11px]" style={{ color: c.id === x.id ? "rgba(255,255,255,0.7)" : MUTED }}>{x.sub}</div></button>)}
          </div>
        </div>
      )}
      <div className="relative overflow-hidden rounded-2xl p-5 sm:p-6 mb-5 text-white" style={{ background: "linear-gradient(135deg,#0A2342,#1B4F8F)", boxShadow: SHADOW }}>
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="min-w-0">
            <div className="text-xs font-semibold tracking-wide" style={{ color: "rgba(255,255,255,0.7)" }}>GAMEWEEK {currentGW}{c.id !== ctxs[0].id || ctxs.length > 1 ? " · " + c.label.toUpperCase() : ""}</div>
            <div className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.8)" }}>{closed ? "Picks are closed for this gameweek." : <>Deadline {koDay(deadlineOf(currentGW))}, {koTime(deadlineOf(currentGW))} · <span className="font-semibold" style={{ color: VOLT }}>{untilDeadline(currentGW, now)}</span></>}</div>
            {picked ? (
              <div className="mt-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-3xl" style={HEAD}>{picked.name}</span>
                  <PosChip pos={picked.pos} />
                </div>
                <div className="flex items-center gap-2 mt-1 text-sm flex-wrap" style={{ color: "rgba(255,255,255,0.8)" }}>
                  <span className="inline-flex items-center gap-1.5 bg-white rounded-full pl-1 pr-2.5 py-0.5" style={{ color: INK }}><Crest team={picked.team} size={20} /><span className="font-semibold">{picked.team}</span></span>
                  <span className="inline-flex items-center gap-1 font-semibold" style={{ color: VOLT }}>{closed ? <Lock size={13} /> : <Check size={13} />} {closed ? lineFor(LOCKED_LINES, currentGW) : "Picked. Change it any time before the deadline."}</span>
                  <button onClick={() => onPick(myPick)} className="text-xs font-semibold underline underline-offset-2 hover:text-white" style={{ color: "rgba(255,255,255,0.7)" }}>Clear pick</button>
                </div>
              </div>
            ) : (
              <div className="mt-1 text-2xl" style={HEAD}>{lineFor(NO_PICK_LINES, currentGW)}</div>
            )}
          </div>
          <div className="w-full sm:w-56">
            <div className="flex justify-between text-xs mb-1.5" style={{ color: "rgba(255,255,255,0.75)" }}>
              <span>{c.progress.label}</span><span className="font-semibold text-white tabular-nums">{c.progress.used} / {c.progress.total}</span>
            </div>
            <div className="h-2 rounded-full" style={{ background: "rgba(255,255,255,0.18)" }}>
              <div className="h-2 rounded-full transition-all" style={{ width: pct + "%", background: VOLT }} />
            </div>
          </div>
        </div>
      </div>

      <FixturesPanel gw={currentGW} fixtures={gwFixtures} />

      <TopPicks fixByTeam={fixByTeam} myPick={myPick} sel={sel} usedIds={usedIds} onPick={choose} closed={closed} />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-52">
          <Search size={16} className="absolute left-3.5 top-3" style={{ color: MUTED }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players or clubs"
            className={field + " w-full pl-10"} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
        </div>
        <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} className={field + " max-w-40"} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} aria-label="Filter by club">
          <option value="ALL">All clubs</option>
          {TEAM_LIST.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="flex gap-1.5">
          {["ALL", "GK", "DEF", "MID", "FWD"].map((p) => <button key={p} onClick={() => setPosFilter(p)}
            className={"px-3.5 py-2 rounded-full text-sm font-semibold transition-colors border " + (posFilter === p ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
            style={posFilter === p ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>{p}</button>)}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-xs" style={{ color: MUTED }}>{teamsShown.length} {teamsShown.length === 1 ? "club" : "clubs"} · {totalShown} {totalShown === 1 ? "player" : "players"}</div>
        <div className="flex items-center gap-1 text-xs font-semibold">
          <button onClick={() => setOpen(new Set(teamsShown))} className="px-2.5 py-1 rounded-lg hover:bg-black/5 transition-colors" style={{ color: BLUE }}>Expand all</button>
          <button onClick={() => setOpen(new Set())} className="px-2.5 py-1 rounded-lg hover:bg-black/5 transition-colors" style={{ color: MUTED }}>Collapse all</button>
        </div>
      </div>

      <div className="space-y-2.5">
        {teamsShown.length === 0 && <div className="rounded-2xl border border-dashed p-8 text-center text-sm" style={{ borderColor: "#C5D0E0", color: MUTED }}>Nothing matches that search. Try a different name or clear the filters.</div>}
        {teamsShown.map((t) => (
          <TeamRow key={t} team={t} players={byTeam[t]} open={open.has(t)} onToggle={() => toggle(t)}
            fixtures={fixByTeam[t] || []} myPick={myPick} sel={sel} usedIds={usedIds} gwUsed={gwUsed} onPick={choose} />
        ))}
      </div>

      {sel && BY_ID[sel] && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-3 pb-3 sm:pb-5 pointer-events-none">
          <div className="max-w-3xl mx-auto pointer-events-auto flex items-center gap-3 rounded-2xl p-3 pl-4 text-white" style={{ background: DEEP, boxShadow: "0 12px 40px rgba(10,35,66,0.45)" }}>
            <Crest team={BY_ID[sel].team} size={34} />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold tracking-wide" style={{ color: "rgba(255,255,255,0.65)" }}>{myPick ? "CHANGE GW" + currentGW + " PICK TO" : "GW" + currentGW + " PICK"}</div>
              <div className="font-bold truncate">{BY_ID[sel].name} <span className="font-medium" style={{ color: "rgba(255,255,255,0.7)" }}>· {BY_ID[sel].team}</span></div>
            </div>
            <button onClick={() => setSel(null)} className="px-3 py-2 rounded-xl text-sm font-semibold hover:bg-white/10 transition-colors" style={{ color: "rgba(255,255,255,0.8)" }}>Cancel</button>
            <button onClick={confirmPick} className="px-4 py-2.5 rounded-xl text-sm font-extrabold hover:brightness-95 transition" style={{ background: VOLT, color: DEEP }}>Confirm pick</button>
          </div>
        </div>
      )}

    </div>
  );
}

function MyPicksView({ official, picks, lpicks, ...rest }) {
  const [w, setW] = useState(official ? "monthly" : "season");
  const showMonthly = official && w === "monthly";
  const src = showMonthly ? (lpicks[official.id] || {}) : picks;
  const tab = (k, label) => <button onClick={() => setW(k)} className={"px-3.5 py-1.5 rounded-full text-sm font-semibold border transition-colors " + (w === k ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
    style={w === k ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>{label}</button>;
  return (
    <div>
      {official && <div className="flex gap-1.5 mb-4">{tab("monthly", "OnePick Monthly")}{tab("season", "OnePick Season")}</div>}
      <SeasonView key={w} picks={src} title={official ? (showMonthly ? "Your monthly picks" : "Your season") : undefined} {...rest} />
    </div>
  );
}

function SeasonView({ picks, currentGW, pts, now, joined, title }) {
  const [openGw, setOpenGw] = useState(null);
  const rows = []; const lastShown = Math.min(TOTAL_GWS, currentGW + 2);
  let total = 0;
  for (let gw = 1; gw <= lastShown; gw++) {
    const pid = picks[gw]; const player = pid ? BY_ID[pid] : null;
    const data = pid ? pts[pid + "|" + gw] : null;
    let status, p = null;
    if (isLocked(gw, now)) {
      if (pid) { status = "scored"; p = data ? data.points : 0; total += p; }
      else if (joined && new Date(deadlineOf(gw)).getTime() < joined) status = "before";
      else { status = "missed"; p = 0; }
    }
    else if (gw === currentGW) status = pid ? "picked" : "open"; else status = "future";
    rows.push({ gw, player, status, pts: p, data });
  }
  const noteFor = (it) => it.label === "Minutes played" ? it.value + " mins" : it.value > 1 ? "× " + it.value : "";
  return (
    <div>
      <div className="flex items-end justify-between mb-4">
        <h2 className="text-2xl" style={HEAD}>{title || "Your season"}</h2>
        <div className="text-sm" style={{ color: MUTED }}>Total <span className="font-extrabold text-xl tabular-nums" style={{ color: BLUE }}>{total}</span> pts</div>
      </div>
      <div className="rounded-2xl bg-white border overflow-hidden" style={{ borderColor: LINE, boxShadow: SHADOW }}>
        <div className="grid grid-cols-12 px-4 py-2.5 text-xs font-semibold border-b" style={{ borderColor: LINE, color: MUTED, background: "#F7F9FC" }}>
          <div className="col-span-2">GW</div><div className="col-span-7">Player</div><div className="col-span-3 text-right">Points</div>
        </div>
        {rows.map((r) => {
          const canOpen = r.status === "scored";
          const isOpen = canOpen && openGw === r.gw;
          const items = r.data ? r.data.breakdown : [];
          return (
          <div key={r.gw} className="border-b last:border-0" style={{ borderColor: "#EEF2F8", background: r.gw === currentGW ? "rgba(31,78,156,0.05)" : undefined }}>
          <div className={"grid grid-cols-12 px-4 py-3 items-center " + (canOpen ? "cursor-pointer hover:bg-black/5 transition-colors" : "")}
            onClick={canOpen ? () => setOpenGw(isOpen ? null : r.gw) : undefined}
            role={canOpen ? "button" : undefined} aria-expanded={canOpen ? isOpen : undefined}>
            <div className="col-span-2 font-bold tabular-nums" style={{ color: MUTED }}>{r.gw}</div>
            <div className="col-span-7 min-w-0">
              {r.player ? <div className="flex items-center gap-2 min-w-0">
                <Crest team={r.player.team} size={22} /><span className="font-semibold truncate">{r.player.name}</span>
                <PosChip pos={r.player.pos} />
                <span className="text-xs truncate hidden sm:inline" style={{ color: MUTED }}>{r.player.team}</span></div>
                : <span className="text-sm" style={{ color: MUTED }}>{r.status === "before" ? "Before you joined" : r.status === "missed" ? "No pick made" : r.status === "open" ? "Pick open" : "—"}</span>}
            </div>
            <div className="col-span-3 text-right">
              {r.status === "scored" && <span className="inline-flex items-center gap-1.5"><span className="font-extrabold tabular-nums" style={{ color: BLUE }}>{r.pts}</span><ChevronDown size={14} className={"transition-transform " + (isOpen ? "rotate-180" : "")} style={{ color: MUTED }} /></span>}
              {r.status === "missed" && <span className="font-bold tabular-nums text-rose-600">0</span>}
              {r.status === "before" && <span className="text-xs" style={{ color: "#98A6BC" }}>—</span>}
              {r.status === "picked" && <span className="text-xs inline-flex items-center gap-1 font-semibold" style={{ color: BLUE }}><Check size={11} /> Picked</span>}
              {r.status === "open" && <span className="text-xs" style={{ color: MUTED }}>Awaiting pick</span>}
              {r.status === "future" && <span className="text-xs" style={{ color: "#98A6BC" }}>Upcoming</span>}
            </div>
          </div>
          {isOpen && (
            <div className="px-4 pb-4">
              <div className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: LINE }}>
                {items.length === 0 && <div className="px-3 py-2 text-sm" style={{ color: MUTED }}>{r.pts === 0 ? "Didn't play, or no points yet." : "Points update shortly."}</div>}
                {items.map((it, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-0" style={{ borderColor: "#EEF2F8" }}>
                    <span className="font-medium">{it.label}{noteFor(it) && <span className="ml-1.5 text-xs" style={{ color: MUTED }}>{noteFor(it)}</span>}</span>
                    <span className="font-bold tabular-nums" style={{ color: it.points < 0 ? "#E11D48" : BLUE }}>{it.points > 0 ? "+" : ""}{it.points}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2 text-sm font-extrabold" style={{ background: "#F7F9FC" }}>
                  <span>GW{r.gw} total{r.data && r.data.provisional ? <span className="ml-2 text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ background: "rgba(217,246,59,0.45)" }}>provisional</span> : null}</span>
                  <span className="tabular-nums" style={{ color: BLUE }}>{r.pts} pts</span>
                </div>
              </div>
            </div>
          )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Leagues: rounds can be the whole season, calendar months, or blocks of N gameweeks. ---- */
const BLOCK_SIZES = [2, 3, 4, 5, 6, 8, 10];
const formatLabel = (f) => !f || f.type === "season" ? "Whole season" : f.type === "monthly" ? "Monthly rounds" : "Every " + f.n + " gameweeks";
function roundsFor(format) {
  const all = Array.from({ length: TOTAL_GWS }, (_, i) => i + 1);
  if (!format || format.type === "season") return [{ id: "season", label: "Season", gws: all }];
  if (format.type === "monthly") return MONTHS.map((m) => ({ id: m.key, label: m.short, long: m.label, gws: m.gws }));
  const n = format.n || 4; const out = [];
  for (let i = 0; i < all.length; i += n) { const g = all.slice(i, i + n); out.push({ id: "b" + i, label: g.length === 1 ? "GW" + g[0] : "GW" + g[0] + "–" + g[g.length - 1], long: "Gameweeks " + g[0] + " to " + g[g.length - 1], gws: g }); }
  return out;
}
const roundState = (r, currentGW) => r.gws[r.gws.length - 1] < currentGW ? "done" : r.gws[0] <= currentGW ? "live" : "upcoming";

// rows: one per member per locked gameweek (from the database); members with nothing locked yet have a single empty row.
function LeagueBoard({ lg, rows, myId, currentGW, openPickId }) {
  const rounds = useMemo(() => roundsFor(lg.format), [lg.format, MONTHS.length]);
  const live = rounds.find((r) => roundState(r, currentGW) === "live") || rounds[rounds.length - 1];
  const multi = rounds.length > 1;
  const [sel, setSel] = useState(live.id);
  const users = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      if (!m.has(r.user_id)) m.set(r.user_id, { id: r.user_id, name: r.username, gws: {} });
      if (r.gameweek_id != null) m.get(r.user_id).gws[r.gameweek_id] = { name: r.player_name, pts: r.points || 0 };
    });
    return [...m.values()];
  }, [rows]);
  const pts = (u, gws) => gws.reduce((n, gw) => n + ((u.gws[gw] || {}).pts || 0), 0);
  const ALL = Array.from({ length: TOTAL_GWS }, (_, i) => i + 1);
  const wins = {};
  const winners = rounds.map((r) => {
    if (roundState(r, currentGW) !== "done") return null;
    const sc = users.map((u) => ({ u, p: pts(u, r.gws) })).sort((a, b) => b.p - a.p);
    if (!sc.length || sc[0].p === 0) return { r, none: true };
    const top = sc.filter((x) => x.p === sc[0].p);
    top.forEach((x) => { wins[x.u.id] = (wins[x.u.id] || 0) + 1; });
    return { r, top: top.map((x) => x.u.name), p: sc[0].p };
  }).filter(Boolean);
  const isOverall = sel === "overall";
  const round = rounds.find((r) => r.id === sel) || live;
  const gws = isOverall ? ALL : round.gws;
  const board = users.map((u) => ({ u, p: pts(u, gws), season: pts(u, ALL), wins: wins[u.id] || 0 })).sort((a, b) => b.p - a.p || a.u.name.localeCompare(b.u.name));
  const state = isOverall ? "live" : roundState(round, currentGW);
  const chip = (id, label, st) => (
    <button key={id} onClick={() => setSel(id)} className={"shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors " + (sel === id ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
      style={sel === id ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>
      {st === "live" && <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" style={{ background: sel === id ? VOLT : "#16A34A" }} />}{label}</button>
  );
  const pickLine = (u) => {
    if (u.id === myId) { const p = openPickId ? BY_ID[openPickId] : null; return `GW${currentGW}: ${p ? p.name : "no pick yet"}`; }
    const last = Object.keys(u.gws).map(Number).sort((a, b) => b - a)[0];
    return last ? `GW${last}: ${u.gws[last].name}` : "No locked picks yet";
  };
  return (
    <div>
      {multi && <div className="flex gap-1.5 overflow-x-auto px-4 py-3 border-b" style={{ borderColor: LINE }}>
        {chip("overall", "Overall", "x")}
        {rounds.map((r) => chip(r.id, r.label, roundState(r, currentGW)))}
      </div>}
      <div className="px-4 pt-3 pb-1 flex items-center justify-between text-xs" style={{ color: MUTED }}>
        <span className="font-semibold">{isOverall ? "Season standings" : round.long || "Full season"}</span>
        <span>{isOverall ? "Total points" : state === "done" ? "Round complete" : state === "live" ? "Round in progress" : "Starts GW" + round.gws[0]}</span>
      </div>
      {board.length === 0 && <div className="px-4 py-6 text-sm text-center" style={{ color: MUTED }}>No one here yet.</div>}
      {board.map((row, i) => {
        const leader = i === 0 && row.p > 0;
        return <div key={row.u.id} className="flex items-center gap-3 px-4 py-2.5 border-b last:border-0" style={{ borderColor: "#EEF2F8", background: row.u.id === myId ? "rgba(31,78,156,0.05)" : undefined }}>
          <div className="w-6 text-center font-extrabold tabular-nums" style={{ color: MUTED }}>{leader ? <Crown size={16} className="mx-auto" style={{ color: "#C9A400" }} /> : i + 1}</div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{row.u.name} {row.u.id === myId && <span className="text-xs font-normal" style={{ color: MUTED }}>(you)</span>}</div>
            <div className="text-xs truncate" style={{ color: MUTED }}>
              {isOverall && multi && row.wins > 0 ? row.wins + (row.wins === 1 ? " round win · " : " round wins · ") : !isOverall && multi ? "Season " + row.season + " · " : ""}
              {pickLine(row.u)}
            </div>
          </div>
          <div className="font-extrabold tabular-nums text-lg" style={{ color: BLUE }}>{row.p}</div>
        </div>;
      })}
      {multi && winners.length > 0 && (
        <div className="px-4 py-3 border-t" style={{ borderColor: LINE, background: "#F7F9FC" }}>
          <div className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>Round winners</div>
          <div className="flex flex-wrap gap-1.5">
            {winners.map((w) => <span key={w.r.id} className="text-xs rounded-full bg-white border px-2.5 py-1" style={{ borderColor: LINE }}>
              <span style={{ color: MUTED }}>{w.r.label}</span> <span className="font-bold">{w.none ? "no score" : w.top.join(" & ")}</span>{!w.none && <span className="tabular-nums" style={{ color: BLUE }}> {w.p}</span>}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

function LeaguesView({ myId, leagues, official, tables, picks, lpicks, currentGW, onCreate, onJoin }) {
  const [name, setName] = useState(""); const [joinCode, setJoinCode] = useState(""); const [joinMsg, setJoinMsg] = useState(""); const [open, setOpen] = useState(null);
  const [reset, setReset] = useState(false); const [openMain, setOpenMain] = useState({ season: true, monthly: true }); const [fmt, setFmt] = useState("monthly"); const [blockN, setBlockN] = useState(4);
  const [created, setCreated] = useState(null); const [copied, setCopied] = useState(false); const [busy, setBusy] = useState(false); const [createErr, setCreateErr] = useState("");
  const card = "rounded-2xl bg-white border p-5";
  const field = "w-full mb-2 px-3.5 py-2.5 rounded-xl bg-white border text-sm focus:outline-none focus:ring-2";
  const format = fmt === "season" ? { type: "season" } : fmt === "monthly" ? { type: "monthly" } : { type: "gws", n: blockN };
  const nRounds = roundsFor(format).length;
  const create = async () => {
    if (!name.trim() || busy) return; setBusy(true); setCreateErr("");
    try { const code = await onCreate(name.trim(), format, reset && fmt !== "season"); setCreated({ name: name.trim(), code }); setName(""); }
    catch (e) { setCreateErr(friendlyError(e.message)); }
    setBusy(false);
  };
  const join = async () => { if (!joinCode.trim()) return; setJoinMsg((await onJoin(joinCode.trim())) || "Joined!"); };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); } catch {} setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const FMTS = [["season", "Whole season", "One winner at the end"], ["monthly", "Monthly", "A fresh round each month"], ["gws", "Gameweeks", "Set your own round length"]];
  const mainRows = tables.main || [];
  const officialRows = official ? (tables[official.id] || []) : null;
  const mains = [{ id: "monthly", name: "OnePick Monthly", sub: "a new winner every month, players come back", format: { type: "monthly" }, rows: officialRows || mainRows, pick: official ? (lpicks[official.id] || {})[currentGW] : picks[currentGW] },
    { id: "season", name: "OnePick Season", sub: "one table, all 38 gameweeks, no repeats", format: { type: "season" }, rows: mainRows, pick: picks[currentGW] }];
  return (
    <div className="grid lg:grid-cols-5 gap-5">
      <div className="lg:col-span-2 space-y-4">
        <div className={card} style={{ borderColor: LINE, boxShadow: SHADOW }}>
          <h3 className="font-bold mb-1 flex items-center gap-2"><Plus size={16} style={{ color: BLUE }} /> Start a league</h3>
          <p className="text-xs mb-3" style={{ color: MUTED }}>You'll get a code to share with your mates.</p>
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="League name" maxLength={40}
            className={field} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          <div className="text-xs font-semibold mt-2 mb-1.5" style={{ color: MUTED }}>How long is each round?</div>
          <div className="grid gap-1.5 mb-2">
            {FMTS.map(([id, t, d]) => <button key={id} onClick={() => setFmt(id)} className="text-left rounded-xl border px-3 py-2 transition-colors hover:bg-black/5"
              style={fmt === id ? { borderColor: BLUE, borderWidth: 2, background: "rgba(31,78,156,0.06)" } : { borderColor: LINE }}>
              <div className="text-sm font-semibold flex items-center justify-between">{t}{fmt === id && <Check size={14} style={{ color: BLUE }} />}</div>
              <div className="text-xs" style={{ color: MUTED }}>{d}</div></button>)}
          </div>
          {fmt === "gws" && <div className="flex items-center gap-2 mb-2 text-sm">
            <span style={{ color: MUTED }}>Each round is</span>
            <select value={blockN} onChange={(e) => setBlockN(Number(e.target.value))} className="px-2.5 py-1.5 rounded-lg bg-white border text-sm" style={{ borderColor: LINE }} aria-label="Gameweeks per round">
              {BLOCK_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
            <span style={{ color: MUTED }}>gameweeks</span></div>}
          {fmt !== "season" && <button onClick={() => setReset(!reset)} className="w-full text-left flex items-start gap-3 rounded-xl border px-3 py-2.5 mb-2 transition-colors hover:bg-black/5"
            style={reset ? { borderColor: BLUE, borderWidth: 2, background: "rgba(31,78,156,0.06)" } : { borderColor: LINE }} role="switch" aria-checked={reset}>
            <span className="mt-0.5 w-9 h-5 shrink-0 rounded-full relative transition-colors" style={{ background: reset ? BLUE : "#C5D0E0" }}>
              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: reset ? 18 : 2 }} /></span>
            <span><span className="block text-sm font-semibold">Reset OnePicks each round</span>
              <span className="block text-xs" style={{ color: MUTED }}>{reset ? "Players come back at the start of every round. Members make a separate pick for this league." : "Off: a player can only be used once all season, same as the main game."}</span></span>
          </button>}
          <div className="text-xs mb-3" style={{ color: MUTED }}>{formatLabel(format)}{fmt !== "season" && reset ? " · picks reset" : ""} · {nRounds === 1 ? "one table, one winner" : nRounds + " rounds, a winner for each plus an overall table"}</div>
          <button onClick={create} disabled={busy} className="w-full py-2.5 rounded-xl text-white font-bold hover:brightness-110 transition disabled:opacity-60" style={{ background: BLUE }}>{busy ? "Creating…" : "Create league"}</button>
          {createErr && <div className="text-sm mt-2 text-rose-600">{createErr}</div>}
          {created && <div className="mt-3 rounded-xl p-3 text-sm" style={{ background: "rgba(217,246,59,0.25)" }}>
            <div className="font-semibold">{created.name} is live.</div>
            <div className="flex items-center justify-between gap-2 mt-1">
              <span>Share code <span className="font-mono tracking-widest font-bold" style={{ color: BLUE }}>{created.code}</span></span>
              <button onClick={() => copy(created.code)} className="text-xs font-bold px-2.5 py-1 rounded-lg bg-white border hover:bg-black/5" style={{ borderColor: LINE }}>{copied ? "Copied" : "Copy code"}</button>
            </div></div>}
        </div>
        <div className={card} style={{ borderColor: LINE, boxShadow: SHADOW }}>
          <h3 className="font-bold mb-3 flex items-center gap-2"><Users size={16} style={{ color: BLUE }} /> Join with a code</h3>
          <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && join()} placeholder="Enter code (e.g. K7P2M)"
            className={field + " tracking-widest"} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          <button onClick={join} className="w-full py-2.5 rounded-xl font-semibold border hover:bg-black/5 transition-colors" style={{ borderColor: LINE }}>Join league</button>
          {joinMsg && <div className={"text-sm mt-2 " + (joinMsg === "Joined!" ? "text-emerald-600" : "text-rose-600")}>{joinMsg}</div>}
        </div>
      </div>
      <div className="lg:col-span-3 space-y-3">
        <h3 className="font-bold flex items-center gap-2"><Trophy size={16} style={{ color: BLUE }} /> Main leagues</h3>
        {mains.map((m) => (
          <div key={m.id} className="rounded-2xl overflow-hidden border" style={{ borderColor: LINE, boxShadow: SHADOW }}>
            <button onClick={() => setOpenMain({ ...openMain, [m.id]: !openMain[m.id] })} className="w-full px-4 py-3.5 text-white flex items-center justify-between gap-3 text-left" style={{ background: "linear-gradient(135deg,#0A2342,#1B4F8F)" }}>
              <div><div className="font-bold">{m.name}</div>
                <div className="text-xs" style={{ color: "rgba(255,255,255,0.75)" }}>Everyone's in · {new Set(m.rows.map((r) => r.user_id)).size} {new Set(m.rows.map((r) => r.user_id)).size === 1 ? "gaffer" : "gaffers"} · {m.sub}</div></div>
              <ChevronRight size={18} className={"shrink-0 transition-transform " + (openMain[m.id] ? "rotate-90" : "")} style={{ color: VOLT }} />
            </button>
            {openMain[m.id] && <div className="bg-white"><LeagueBoard lg={m} rows={m.rows} myId={myId} currentGW={currentGW} openPickId={m.pick} /></div>}
          </div>
        ))}

        <h3 className="font-bold flex items-center gap-2 pt-3"><Users size={16} style={{ color: BLUE }} /> Your leagues</h3>
        {leagues.length === 0 && <div className="rounded-2xl border border-dashed p-8 text-center text-sm" style={{ borderColor: "#C5D0E0", color: MUTED }}>No private leagues yet. Start one, or join a mate's with their code.</div>}
        {leagues.map((lg) => {
          const isOpen = open === lg.id;
          const usesOwn = lg.reset && lg.format.type !== "season";
          return <div key={lg.id} className="rounded-2xl bg-white border overflow-hidden" style={{ borderColor: LINE, boxShadow: SHADOW }}>
            <button onClick={() => setOpen(isOpen ? null : lg.id)} className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-black/5 transition-colors">
              <div className="text-left"><div className="font-bold">{lg.name}</div>
                <div className="text-xs" style={{ color: MUTED }}>{lg.memberCount} {lg.memberCount === 1 ? "gaffer" : "gaffers"} · {formatLabel(lg.format)}{lg.reset ? " · picks reset" : ""} · code <span className="font-mono tracking-widest font-semibold" style={{ color: BLUE }}>{lg.code}</span></div></div>
              <ChevronRight size={18} className={"transition-transform " + (isOpen ? "rotate-90" : "")} style={{ color: MUTED }} />
            </button>
            {isOpen && <div className="border-t" style={{ borderColor: LINE }}>
              <LeagueBoard lg={lg} rows={tables[lg.id] || []} myId={myId} currentGW={currentGW} openPickId={usesOwn ? (lpicks[lg.id] || {})[currentGW] : picks[currentGW]} /></div>}
          </div>;
        })}
      </div>
    </div>
  );
}

function RulesView() {
  const rules = [
    { t: "One pick a week", d: "Every gameweek, choose one Premier League player. Just one." },
    { t: "Once a month", d: "Once a player has been your pick, he's off the table until the 1st of next month, when everyone comes back. Spend the big names early or save them for the run-in. Your call, gaffer." },
    { t: "Scoring is just FPL", d: "Goals, assists, clean sheets, bonus points. The usual, nothing new to learn." },
    { t: "Most points wins", d: "Add up the gameweeks in the month. The highest total wins that month. Win a few and you're a legend." },
    { t: "Bring your mates", d: "Everyone is in OnePick Monthly, with a new winner every month. For the long game there is also OnePick Season, where each player can only be used once all year. Or start your own league, share the code, and choose the round length." },
  ];
  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl mb-1" style={HEAD}>How it works</h2>
      <p className="mb-6" style={{ color: MUTED }}>{SUBTAGLINE}</p>
      <div className="space-y-3">
        {rules.map((r, i) => <div key={i} className="flex gap-3 rounded-2xl bg-white border p-4" style={{ borderColor: LINE, boxShadow: SHADOW }}>
          <div className="w-8 h-8 shrink-0 rounded-lg font-extrabold flex items-center justify-center tabular-nums" style={{ background: VOLT, color: INK }}>{i + 1}</div>
          <div><div className="font-bold">{r.t}</div><div className="text-sm mt-0.5" style={{ color: MUTED }}>{r.d}</div></div>
        </div>)}
      </div>
      <div className="mt-6 text-sm rounded-2xl border p-4 bg-white" style={{ borderColor: LINE, color: MUTED }}>
        <span className="font-semibold" style={{ color: INK }}>The small print:</span> picks lock at the gameweek deadline, and other people's picks stay hidden until then. If you forget to pick, you score zero for that week.
      </div>
    </div>
  );
}
