import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient, upsertChunked } from "./db.js";

/* Pre-gameweek email digest. Run hourly. In the 24 hours before a gameweek's pick deadline it emails every
   subscribed player once (digest_log stops repeats) with: the week's fixtures, the players they have picked,
   their points, and the players most likely to score this week. Sending goes through Resend's HTTP API. */

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;
const DIFF_FACTOR: Record<number, number> = { 1: 1.2, 2: 1.1, 3: 1, 4: 0.9, 5: 0.8 };   // same as the website
const TZ = "Europe/London";

export interface Mail { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }
export type Mailer = (m: Mail) => Promise<void>;

/* ---------- reading the database ---------- */
async function rows(db: SupabaseClient, table: string, cols: string, f: (q: any) => any = (q) => q): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function listUsers(db: SupabaseClient): Promise<{ id: string; email: string }[]> {
  const out: { id: string; email: string }[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`users: ${error.message}`);
    for (const u of data.users) if (u.email && u.email_confirmed_at) out.push({ id: u.id, email: u.email });
    if (data.users.length < 1000) return out;
  }
}

/* ---------- the numbers (pure, so they can be tested without a database) ---------- */
export interface Inputs {
  gw: number; deadline: string; roundLength: number;
  teams: { id: number; name: string; short_name: string }[];
  players: { id: number; web_name: string; team_id: number; position: string; status: string; form: number; chance_next: number | null; news: string | null }[];
  fixtures: { home_team_id: number; away_team_id: number; kickoff_at: string | null; home_difficulty: number | null; away_difficulty: number | null }[];
  picks: { user_id: string; gameweek_id: number; player_id: number; slot: string }[];   // official league, this period plus last gameweek
  points: { player_id: number; gameweek_id: number; points: number }[];
  usernames: Record<string, string>;
}
export interface Tip { id: number; name: string; team: string; position: string; opp: string; expected: number; picked: boolean }
export interface Row { slot: string; name: string; team: string; opp: string; flag: string | null }
export interface Digest {
  gw: number; deadline: string; username: string; picks: Row[]; missing: string[];
  periodLabel: string; periodPts: number; periodRank: number; periodOf: number; lastPts: number | null; freshStart: boolean;
  tips: Tip[]; fixtures: { day: string; games: { home: string; away: string; time: string; homeDiff: number | null; awayDiff: number | null }[] }[];
}

export const periodRange = (gw: number, len: number) => { const s = Math.floor((gw - 1) / len) * len + 1; return { start: s, end: Math.min(38, s + len - 1) }; };
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...o }).format(new Date(iso));
export const dayLabel = (iso: string) => fmt(iso, { weekday: "short", day: "numeric", month: "short" });
export const timeLabel = (iso: string) => fmt(iso, { hour: "2-digit", minute: "2-digit", hour12: false });

export function buildDigest(inp: Inputs, userId: string): Digest {
  const { gw } = inp;
  const { start, end } = periodRange(gw, inp.roundLength);
  const team = new Map(inp.teams.map((t) => [t.id, t]));
  const player = new Map(inp.players.map((p) => [p.id, p]));
  const pts = new Map(inp.points.map((x) => [x.player_id + "|" + x.gameweek_id, x.points]));

  // this gameweek's fixtures for each club
  const byTeam = new Map<number, { opp: string; home: boolean; diff: number | null }[]>();
  for (const f of inp.fixtures) {
    const h = team.get(f.home_team_id)?.short_name ?? "?", a = team.get(f.away_team_id)?.short_name ?? "?";
    (byTeam.get(f.home_team_id) ?? byTeam.set(f.home_team_id, []).get(f.home_team_id)!).push({ opp: a + " (H)", home: true, diff: f.home_difficulty });
    (byTeam.get(f.away_team_id) ?? byTeam.set(f.away_team_id, []).get(f.away_team_id)!).push({ opp: h + " (A)", home: false, diff: f.away_difficulty });
  }
  const oppText = (tid: number) => (byTeam.get(tid) ?? []).map((x) => x.opp).join(", ") || "no fixture";

  // period table (points from picks made before this gameweek)
  const totals = new Map<string, number>();
  for (const p of inp.picks) if (p.gameweek_id >= start && p.gameweek_id < gw) totals.set(p.user_id, (totals.get(p.user_id) ?? 0) + (pts.get(p.player_id + "|" + p.gameweek_id) ?? 0));
  const everyone = new Set(inp.picks.filter((p) => p.gameweek_id >= start && p.gameweek_id <= gw).map((p) => p.user_id));
  everyone.add(userId);
  const mine = totals.get(userId) ?? 0;
  const rank = 1 + [...everyone].filter((u) => (totals.get(u) ?? 0) > mine).length;

  // my picks for this gameweek
  const myNow = inp.picks.filter((p) => p.user_id === userId && p.gameweek_id === gw);
  const picks: Row[] = POSITIONS.flatMap((slot) => {
    const pk = myNow.find((x) => x.slot === slot); const pl = pk && player.get(pk.player_id);
    if (!pl) return [];
    const flag = pl.status === "a" && (pl.chance_next == null || pl.chance_next >= 100) ? null : (pl.news || (pl.status === "a" ? "Fitness doubt" : "Not available"));
    return [{ slot, name: pl.web_name, team: team.get(pl.team_id)?.short_name ?? "", opp: oppText(pl.team_id), flag }];
  });
  const missing = POSITIONS.filter((s) => !myNow.some((x) => x.slot === s));

  // players already used in this period can't be picked again, so they aren't suggested
  const used = new Set(inp.picks.filter((p) => p.user_id === userId && p.gameweek_id >= start && p.gameweek_id < gw).map((p) => p.player_id));
  const picked = new Set(myNow.map((p) => p.player_id));
  const scored = inp.players.flatMap((p) => {
    const list = byTeam.get(p.team_id) ?? [];
    if (!list.length || ["s", "u", "n"].includes(p.status) || used.has(p.id)) return [];
    let e = list.reduce((t, f) => t + Number(p.form) * (DIFF_FACTOR[f.diff ?? 3] ?? 1), 0);
    if (p.chance_next != null) e *= p.chance_next / 100;
    return e > 0 ? [{ p, e }] : [];
  }).sort((a, b) => b.e - a.e);
  const tips: Tip[] = POSITIONS.flatMap((pos) => scored.filter((x) => x.p.position === pos).slice(0, 2).map(({ p, e }) => ({
    id: p.id, name: p.web_name, team: team.get(p.team_id)?.short_name ?? "", position: pos, opp: oppText(p.team_id), expected: Math.round(e * 10) / 10, picked: picked.has(p.id),
  })));

  // fixtures grouped by day
  const days = new Map<string, Digest["fixtures"][number]["games"]>();
  for (const f of [...inp.fixtures].sort((a, b) => (a.kickoff_at ?? "9").localeCompare(b.kickoff_at ?? "9"))) {
    const d = f.kickoff_at ? dayLabel(f.kickoff_at) : "Date to be confirmed";
    (days.get(d) ?? days.set(d, []).get(d)!).push({
      home: team.get(f.home_team_id)?.name ?? "?", away: team.get(f.away_team_id)?.name ?? "?",
      time: f.kickoff_at ? timeLabel(f.kickoff_at) : "TBC", homeDiff: f.home_difficulty, awayDiff: f.away_difficulty,
    });
  }

  const lastRow = inp.picks.filter((p) => p.user_id === userId && p.gameweek_id === gw - 1);
  return {
    gw, deadline: inp.deadline, username: inp.usernames[userId] ?? "gaffer", picks, missing,
    periodLabel: start === end ? `GW${start}` : `GW${start}–${end}`, periodPts: mine, periodRank: rank, periodOf: everyone.size,
    lastPts: gw > 1 && lastRow.length ? lastRow.reduce((t, p) => t + (pts.get(p.player_id + "|" + p.gameweek_id) ?? 0), 0) : null,
    freshStart: start === gw, tips,
    fixtures: [...days.entries()].map(([day, games]) => ({ day, games })),
  };
}

/* ---------- the email ---------- */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const POS_COL: Record<string, [string, string]> = { GK: ["#E0F2FE", "#075985"], DEF: ["#D1FAE5", "#065F46"], MID: ["#FEF3C7", "#92400E"], FWD: ["#FFE4E6", "#9F1239"] };
const pill = (pos: string) => { const [bg, fg] = POS_COL[pos] ?? ["#eee", "#333"]; return `<span style="display:inline-block;min-width:34px;text-align:center;font-size:11px;font-weight:800;padding:3px 7px;border-radius:6px;background:${bg};color:${fg}">${pos}</span>`; };
const deadlineText = (iso: string) => `${dayLabel(iso)}, ${timeLabel(iso)}`;

export function renderEmail(d: Digest, siteUrl: string, unsubUrl: string): { subject: string; html: string; text: string } {
  const dl = deadlineText(d.deadline);
  const subject = `GW${d.gw}: picks lock ${dayLabel(d.deadline)} at ${timeLabel(d.deadline)}`;
  const lead = d.picks.length === 4
    ? `Your four picks are in. You can change them until ${dl}.`
    : `You have ${d.picks.length === 0 ? "not picked yet" : "picked " + d.picks.length + " of 4"}. Missing: ${d.missing.join(", ")}. Picks lock ${dl}.`;
  const sec = (title: string, body: string) => `<tr><td style="padding:22px 28px 0"><div style="font-size:12px;font-weight:800;letter-spacing:.08em;color:#5A6B85;margin-bottom:10px">${title}</div>${body}</td></tr>`;

  const pickRows = d.picks.map((p) => `<tr><td style="padding:8px 0;border-bottom:1px solid #EEF2F8;width:46px">${pill(p.slot)}</td><td style="padding:8px 0;border-bottom:1px solid #EEF2F8;font-size:15px"><b>${esc(p.name)}</b> <span style="color:#5A6B85">${esc(p.team)} · ${esc(p.opp)}</span>${p.flag ? `<div style="font-size:12px;color:#92400E;margin-top:2px">⚠ ${esc(p.flag)}</div>` : ""}</td></tr>`).join("");
  const missingRows = d.missing.map((s) => `<tr><td style="padding:8px 0;border-bottom:1px solid #EEF2F8;width:46px">${pill(s)}</td><td style="padding:8px 0;border-bottom:1px solid #EEF2F8;font-size:15px;color:#B3153B"><b>Not picked yet</b></td></tr>`).join("");

  const stat = (v: string, l: string) => `<td align="center" style="padding:14px 6px;background:#F2F5FA;border-radius:12px"><div style="font-size:24px;font-weight:800;color:#1F4E9C">${v}</div><div style="font-size:11px;color:#5A6B85;font-weight:700">${l}</div></td>`;
  const stats = d.freshStart
    ? `<div style="font-size:15px;color:#28374F"><b>Fresh start.</b> A new period begins with GW${d.gw}: every player is available again and the table resets.${d.lastPts != null ? ` You scored ${d.lastPts} last gameweek.` : ""}</div>`
    : `<table width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate"><tr>${stat(String(d.periodPts), "POINTS · " + d.periodLabel)}${stat(`${d.periodRank}<span style="font-size:13px;color:#5A6B85">/${d.periodOf}</span>`, "RANK")}${d.lastPts != null ? stat(String(d.lastPts), "LAST GW") : ""}</tr></table>`;

  const tipRows = d.tips.map((t) => `<tr><td style="padding:7px 0;border-bottom:1px solid #EEF2F8;width:46px">${pill(t.position)}</td><td style="padding:7px 0;border-bottom:1px solid #EEF2F8;font-size:14px"><b>${esc(t.name)}</b>${t.picked ? ` <span style="font-size:11px;font-weight:800;color:#065F46;background:#D1FAE5;border-radius:5px;padding:1px 6px">YOUR PICK</span>` : ""} <span style="color:#5A6B85">${esc(t.team)} · ${esc(t.opp)}</span></td><td align="right" style="padding:7px 0;border-bottom:1px solid #EEF2F8;font-size:14px;font-weight:800;color:#1F4E9C">~${t.expected}</td></tr>`).join("");

  const fx = d.fixtures.map((day) => `<div style="font-size:12px;font-weight:800;color:#1F4E9C;margin:12px 0 4px">${esc(day.day)}</div>` + day.games.map((g) => `<div style="font-size:14px;padding:4px 0;color:#0B1B33"><span style="color:#5A6B85;display:inline-block;width:44px">${g.time}</span>${esc(g.home)} <span style="color:#5A6B85">v</span> ${esc(g.away)}</div>`).join("")).join("");

  const html = `<!doctype html><html><body style="margin:0;background:#E9EEF6;font-family:Inter,Arial,Helvetica,sans-serif;color:#0B1B33">
<div style="display:none;max-height:0;overflow:hidden">${esc(lead)}</div>
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 10px">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:18px;overflow:hidden">
<tr><td style="background:#0A2342;padding:24px 28px"><div style="font-family:'Arial Black',Arial,sans-serif;font-size:26px;letter-spacing:-.04em"><span style="color:#fff">One</span><span style="color:#D9F63B">Pick</span></div>
<div style="color:#fff;font-size:28px;font-weight:800;margin-top:14px">Gameweek ${d.gw} is almost here</div>
<div style="color:#C9D6EA;font-size:14px;margin-top:6px">Picks lock <b style="color:#D9F63B">${esc(dl)}</b></div></td></tr>
<tr><td style="padding:22px 28px 0;font-size:15px;line-height:1.5">Hi ${esc(d.username)}. ${esc(lead)}</td></tr>
${sec("YOUR PICKS", `<table width="100%" cellpadding="0" cellspacing="0">${pickRows}${missingRows}</table>`)}
${sec("YOUR POINTS", stats)}
${d.tips.length ? sec("MOST LIKELY TO SCORE THIS WEEK", `<table width="100%" cellpadding="0" cellspacing="0">${tipRows}</table><div style="font-size:11px;color:#5A6B85;margin-top:8px">Estimate from recent form, fixture difficulty and fitness. Players you've already used this period are left out.</div>`) : ""}
${d.fixtures.length ? sec("GAMEWEEK " + d.gw + " FIXTURES", fx) : ""}
<tr><td align="center" style="padding:26px 28px"><a href="${esc(siteUrl)}" style="display:inline-block;background:#1F4E9C;color:#fff;font-weight:800;font-size:15px;text-decoration:none;padding:14px 28px;border-radius:12px">${d.missing.length ? "Make your picks" : "Review your picks"}</a></td></tr>
<tr><td style="background:#F2F5FA;padding:16px 28px;font-size:11px;color:#5A6B85;line-height:1.5">OnePick is an unofficial fan game, not affiliated with the Premier League. You're getting this because you have an account. <a href="${esc(unsubUrl)}" style="color:#1F4E9C">Unsubscribe from these emails</a>.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `OnePick · Gameweek ${d.gw}`, `Picks lock ${dl}`, "", `Hi ${d.username}. ${lead}`, "",
    "YOUR PICKS", ...d.picks.map((p) => `  ${p.slot}  ${p.name} (${p.team}) ${p.opp}${p.flag ? "  !! " + p.flag : ""}`), ...d.missing.map((s) => `  ${s}  not picked yet`), "",
    "YOUR POINTS", d.freshStart ? `  Fresh start: a new period begins with GW${d.gw}.${d.lastPts != null ? ` Last gameweek: ${d.lastPts}.` : ""}` : `  ${d.periodPts} pts in ${d.periodLabel} (rank ${d.periodRank} of ${d.periodOf})${d.lastPts != null ? `, last gameweek ${d.lastPts}` : ""}`, "",
    ...(d.tips.length ? ["MOST LIKELY TO SCORE", ...d.tips.map((t) => `  ${t.position}  ${t.name} (${t.team}) ${t.opp}  ~${t.expected}${t.picked ? "  [your pick]" : ""}`), ""] : []),
    `GAMEWEEK ${d.gw} FIXTURES`, ...d.fixtures.flatMap((day) => [`  ${day.day}`, ...day.games.map((g) => `    ${g.time}  ${g.home} v ${g.away}`)]), "",
    `Open OnePick: ${siteUrl}`, `Unsubscribe: ${unsubUrl}`,
  ].join("\n");
  return { subject, html, text };
}

/* ---------- sending ---------- */
export function resendMailer(apiKey: string, from: string, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Mailer {
  return async (m) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers }),
      });
      if (res.ok) { await sleep(600); return; }               // Resend allows 2 requests a second
      if (res.status === 429) { await sleep(1500); continue; }
      throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    throw new Error("Resend: rate limited");
  };
}

/* ---------- the job ---------- */
export interface DigestOptions { siteUrl: string; leadHours?: number; dryRun?: boolean }
export interface DigestResult { gameweek: number | null; sent: number; skipped: number; failed: number }

export async function runDigest(db: SupabaseClient, mail: Mailer, now: Date, opt: DigestOptions): Promise<DigestResult> {
  const lead = (opt.leadHours ?? 24) * 3600e3;
  const gws = await rows(db, "gameweeks", "id, deadline_at");
  const next = gws.filter((g) => new Date(g.deadline_at).getTime() > now.getTime()).sort((a, b) => a.id - b.id)[0];
  if (!next || new Date(next.deadline_at).getTime() - now.getTime() > lead) return { gameweek: null, sent: 0, skipped: 0, failed: 0 };
  const gw: number = next.id;

  const [official] = await rows(db, "leagues", "id, round_type, round_length", (q) => q.eq("is_official", true));
  if (!official) return { gameweek: gw, sent: 0, skipped: 0, failed: 0 };
  const roundLength = official.round_type === "gameweeks" && official.round_length ? official.round_length : 4;
  const { start } = periodRange(gw, roundLength);
  const ids = [...new Set([start, gw - 1, gw].filter((x) => x >= 1))];
  const wanted: number[] = []; for (let i = Math.min(...ids); i <= gw; i++) wanted.push(i);

  const [teams, players, fixtures, picks, points, profiles, prefs, logged, users] = await Promise.all([
    rows(db, "teams", "id, name, short_name"),
    rows(db, "players", "id, web_name, team_id, position, status, form, chance_next, news"),
    rows(db, "fixtures", "home_team_id, away_team_id, kickoff_at, home_difficulty, away_difficulty", (q) => q.eq("gameweek_id", gw)),
    rows(db, "league_picks", "user_id, gameweek_id, player_id, slot", (q) => q.eq("league_id", official.id).in("gameweek_id", wanted)),
    rows(db, "player_gw_points", "player_id, gameweek_id, points", (q) => q.in("gameweek_id", wanted)),
    rows(db, "profiles", "id, username"),
    rows(db, "digest_prefs", "user_id, enabled, token"),
    rows(db, "digest_log", "user_id", (q) => q.eq("gameweek_id", gw)),
    listUsers(db),
  ]);

  const done = new Set(logged.map((r) => r.user_id));
  const pref = new Map(prefs.map((p) => [p.user_id, p]));
  const todo = users.filter((u) => !done.has(u.id) && pref.get(u.id)?.enabled !== false);
  const skipped = users.length - todo.length;

  // every recipient needs an unsubscribe token; create the missing rows (the database fills in the token)
  const fresh = todo.filter((u) => !pref.get(u.id));
  if (fresh.length && !opt.dryRun) {
    await upsertChunked(db, "digest_prefs", fresh.map((u) => ({ user_id: u.id })), "user_id");
    for (const p of await rows(db, "digest_prefs", "user_id, enabled, token")) pref.set(p.user_id, p);
  }

  const inp: Omit<Inputs, "usernames"> = { gw, deadline: next.deadline_at, roundLength, teams, players, fixtures, picks, points };
  const usernames = Object.fromEntries(profiles.map((p) => [p.id, p.username]));
  let sent = 0, failed = 0;
  for (const u of todo) {
    const token = pref.get(u.id)?.token;
    if (!token && !opt.dryRun) { failed++; console.error(`no unsubscribe token for ${u.id}`); continue; }
    const base = opt.siteUrl.replace(/\/$/, "");
    const unsub = `${base}/#unsubscribe=${token ?? "preview"}`;
    const e = renderEmail(buildDigest({ ...inp, usernames }, u.id), base, unsub);
    try {
      if (opt.dryRun) console.log(`[dry run] would email ${u.email}: ${e.subject}`);
      else {
        await mail({ to: u.email, ...e, headers: { "List-Unsubscribe": `<${unsub}>` } });
        await upsertChunked(db, "digest_log", [{ gameweek_id: gw, user_id: u.id }], "gameweek_id,user_id");
      }
      sent++;
    } catch (err) { failed++; console.error(`email to ${u.id} failed: ${(err as Error).message}`); }
  }
  return { gameweek: gw, sent, skipped, failed };
}

/* run from the command line: npm run digest */
if (process.argv[1]?.endsWith("digest.ts")) {
  const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM, site = process.env.SITE_URL;
  const dryRun = process.env.DRY_RUN === "1";
  if (!site || (!dryRun && (!key || !from))) { console.error("Set SITE_URL, RESEND_API_KEY and MAIL_FROM (or DRY_RUN=1 to preview without sending)"); process.exit(1); }
  runDigest(serviceClient(), key && from ? resendMailer(key, from) : async () => {}, new Date(), { siteUrl: site, dryRun })
    .then((r) => { console.log(JSON.stringify(r)); if (r.failed) process.exitCode = 1; })
    .catch((e) => { console.error(e); process.exit(1); });
}
