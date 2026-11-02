import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertChunked } from "./db.js";
import { rows, listUsers, esc, pill, dayLabel, timeLabel, deadlineText, periodRange, type Mailer, type DigestOptions, type DigestResult } from "./digest.js";

/* After-gameweek results email. Once a gameweek has settled (last game finished plus 12 hours, the same moment the website
   moves on), every subscribed player gets: how their four picks scored, where they stand in the period table, everyone's
   picks and points, the week's top scorers and a nudge for the next deadline. Sent once per player per gameweek. */

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;
const SETTLE_HOURS = 14;          // kick-off of the last game, plus about 2 hours to finish, plus 12 hours
const MAX_AGE_HOURS = 72;         // never send results for a gameweek that settled more than 3 days ago

export interface ResultsInputs {
  gw: number; roundLength: number; next: { gw: number; deadline: string } | null;
  teams: { id: number; short_name: string }[];
  players: { id: number; web_name: string; team_id: number; position: string }[];
  picks: { user_id: string; gameweek_id: number; player_id: number; slot: string }[];     // official league: this period, plus the next gameweek
  points: { player_id: number; gameweek_id: number; points: number; breakdown: { label: string; value: number; points: number }[] | null }[];
  usernames: Record<string, string>;
}
export interface PickResult { slot: string; name: string; team: string; pts: number; note: string }
export interface TableRow { rank: number; name: string; you: boolean; gwPts: number; periodPts: number; picks: { pos: string; name: string; pts: number }[] }
export interface Results {
  gw: number; username: string; picks: PickResult[]; gwPts: number; gwRank: number; gwOf: number;
  periodLabel: string; periodPts: number; periodRank: number; periodOf: number; freshStart: boolean;
  table: TableRow[]; top: { name: string; team: string; pos: string; pts: number }[];
  next: { gw: number; deadline: string; picked: number } | null;
}

const note = (bd: { label: string; value: number; points: number }[] | null) =>
  (bd ?? []).filter((b) => b.points > 0 && b.label !== "Minutes played" && b.label !== "Other").sort((a, b) => b.points - a.points).slice(0, 3)
    .map((b) => (b.value > 1 ? `${b.label} x${b.value}` : b.label)).join(", ");

export function buildResults(inp: ResultsInputs, userId: string): Results {
  const { gw } = inp;
  const { start, end } = periodRange(gw, inp.roundLength);
  const team = new Map(inp.teams.map((t) => [t.id, t.short_name]));
  const player = new Map(inp.players.map((p) => [p.id, p]));
  const bd = new Map(inp.points.map((x) => [x.player_id + "|" + x.gameweek_id, x]));
  const ptsOf = (pid: number, g: number) => bd.get(pid + "|" + g)?.points ?? 0;
  const order = (pos: string) => POSITIONS.indexOf(pos as (typeof POSITIONS)[number]);

  const inPeriod = inp.picks.filter((p) => p.gameweek_id >= start && p.gameweek_id <= gw);
  const people = new Set(inPeriod.map((p) => p.user_id)); people.add(userId);
  const gwTotal = (u: string) => inp.picks.filter((p) => p.user_id === u && p.gameweek_id === gw).reduce((n, p) => n + ptsOf(p.player_id, gw), 0);
  const periodTotal = (u: string) => inPeriod.filter((p) => p.user_id === u).reduce((n, p) => n + ptsOf(p.player_id, p.gameweek_id), 0);
  const gwScorers = new Set(inp.picks.filter((p) => p.gameweek_id === gw).map((p) => p.user_id)); gwScorers.add(userId);
  const mineGw = gwTotal(userId), minePeriod = periodTotal(userId);

  const picksOf = (u: string) => inp.picks.filter((p) => p.user_id === u && p.gameweek_id === gw && player.has(p.player_id))
    .sort((a, b) => order(player.get(a.player_id)!.position) - order(player.get(b.player_id)!.position));
  const myPicks: PickResult[] = picksOf(userId).map((p) => { const pl = player.get(p.player_id)!; return { slot: pl.position, name: pl.web_name, team: team.get(pl.team_id) ?? "", pts: ptsOf(p.player_id, gw), note: note(bd.get(p.player_id + "|" + gw)?.breakdown ?? null) }; });

  const sorted = [...people].map((u) => ({ u, g: gwTotal(u), p: periodTotal(u) })).sort((a, b) => b.p - a.p || b.g - a.g || (inp.usernames[a.u] ?? "").localeCompare(inp.usernames[b.u] ?? ""));
  const table: TableRow[] = sorted.map((x) => ({
    rank: 1 + sorted.filter((y) => y.p > x.p).length, name: inp.usernames[x.u] ?? "gaffer", you: x.u === userId, gwPts: x.g, periodPts: x.p,
    picks: picksOf(x.u).map((p) => { const pl = player.get(p.player_id)!; return { pos: pl.position, name: pl.web_name, pts: ptsOf(p.player_id, gw) }; }),
  }));
  const shown = table.slice(0, 15); const me = table.find((t) => t.you); if (me && !shown.includes(me)) shown.push(me);

  const top = inp.points.filter((x) => x.gameweek_id === gw && x.points > 0 && player.has(x.player_id)).sort((a, b) => b.points - a.points || player.get(a.player_id)!.web_name.localeCompare(player.get(b.player_id)!.web_name)).slice(0, 5)
    .map((x) => { const pl = player.get(x.player_id)!; return { name: pl.web_name, team: team.get(pl.team_id) ?? "", pos: pl.position, pts: x.points }; });

  return {
    gw, username: inp.usernames[userId] ?? "gaffer", picks: myPicks, gwPts: mineGw,
    gwRank: 1 + [...gwScorers].filter((u) => gwTotal(u) > mineGw).length, gwOf: gwScorers.size,
    periodLabel: start === end ? `GW${start}` : `GW${start}–${end}`, periodPts: minePeriod, periodRank: 1 + [...people].filter((u) => periodTotal(u) > minePeriod).length, periodOf: people.size,
    freshStart: false, table: shown, top,
    next: inp.next ? { gw: inp.next.gw, deadline: inp.next.deadline, picked: inp.picks.filter((p) => p.user_id === userId && p.gameweek_id === inp.next!.gw).length } : null,
  };
}

export function renderResults(r: Results, siteUrl: string, unsubUrl: string): { subject: string; html: string; text: string } {
  const subject = `GW${r.gw} results: you scored ${r.gwPts} (#${r.gwRank} of ${r.gwOf} this week)`;
  const sec = (title: string, body: string) => `<tr><td style="padding:22px 28px 0"><div style="font-size:12px;font-weight:800;letter-spacing:.08em;color:#5A6B85;margin-bottom:10px">${title}</div>${body}</td></tr>`;
  const stat = (v: string, l: string, hot = false) => `<td align="center" style="padding:14px 6px;background:${hot ? "#D9F63B" : "#F2F5FA"};border-radius:12px"><div style="font-size:24px;font-weight:800;color:${hot ? "#0A2342" : "#1F4E9C"}">${v}</div><div style="font-size:11px;color:${hot ? "#0A2342" : "#5A6B85"};font-weight:700">${l}</div></td>`;
  const mine = r.picks.map((p) => `<tr><td style="padding:8px 0;border-bottom:1px solid #EEF2F8;width:46px">${pill(p.slot)}</td><td style="padding:8px 0;border-bottom:1px solid #EEF2F8;font-size:15px"><b>${esc(p.name)}</b> <span style="color:#5A6B85">${esc(p.team)}${p.note ? " · " + esc(p.note) : ""}</span></td><td align="right" style="padding:8px 0;border-bottom:1px solid #EEF2F8;font-size:18px;font-weight:800;color:#1F4E9C">${p.pts}</td></tr>`).join("")
    || `<tr><td style="font-size:14px;color:#5A6B85;padding:6px 0">You didn't make any picks this gameweek.</td></tr>`;
  const table = r.table.map((t) => `<tr style="background:${t.you ? "rgba(31,78,156,0.07)" : "#fff"}"><td style="padding:9px 6px;border-bottom:1px solid #EEF2F8;width:26px;font-weight:800;color:#5A6B85;vertical-align:top">${t.rank}</td><td style="padding:9px 6px;border-bottom:1px solid #EEF2F8;font-size:14px"><b>${esc(t.name)}</b>${t.you ? ` <span style="color:#5A6B85">(you)</span>` : ""}<div style="font-size:12px;color:#5A6B85;margin-top:2px">${t.picks.length ? t.picks.map((p) => `${esc(p.name)} ${p.pts}`).join(" · ") : "No picks"}</div></td><td align="right" style="padding:9px 6px;border-bottom:1px solid #EEF2F8;font-size:13px;color:#5A6B85;vertical-align:top">+${t.gwPts}</td><td align="right" style="padding:9px 6px;border-bottom:1px solid #EEF2F8;font-size:18px;font-weight:800;color:#1F4E9C;vertical-align:top">${t.periodPts}</td></tr>`).join("");
  const top = r.top.map((t) => `<tr><td style="padding:6px 0;border-bottom:1px solid #EEF2F8;width:46px">${pill(t.pos)}</td><td style="padding:6px 0;border-bottom:1px solid #EEF2F8;font-size:14px"><b>${esc(t.name)}</b> <span style="color:#5A6B85">${esc(t.team)}</span></td><td align="right" style="padding:6px 0;border-bottom:1px solid #EEF2F8;font-weight:800;color:#1F4E9C">${t.pts}</td></tr>`).join("");
  const nxt = r.next ? `<div style="font-size:14px;color:#28374F">Gameweek ${r.next.gw} picks lock <b>${esc(deadlineText(r.next.deadline))}</b>. ${r.next.picked >= 4 ? "All four of your picks are in." : `You have picked ${r.next.picked} of 4.`}</div>` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#E9EEF6;font-family:Inter,Arial,Helvetica,sans-serif;color:#0B1B33">
<div style="display:none;max-height:0;overflow:hidden">You scored ${r.gwPts} in gameweek ${r.gw}. You are #${r.periodRank} of ${r.periodOf} in ${esc(r.periodLabel)}.</div>
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 10px">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:18px;overflow:hidden">
<tr><td style="background:#0A2342;padding:24px 28px"><div style="font-family:'Arial Black',Arial,sans-serif;font-size:26px;letter-spacing:-.04em"><span style="color:#fff">One</span><span style="color:#D9F63B">Pick</span></div>
<div style="color:#fff;font-size:28px;font-weight:800;margin-top:14px">Gameweek ${r.gw} results</div>
<div style="color:#C9D6EA;font-size:14px;margin-top:6px">Hi ${esc(r.username)}. Here is how your team did.</div></td></tr>
<tr><td style="padding:22px 28px 0"><table width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate"><tr>${stat(String(r.gwPts), "GW" + r.gw + " POINTS", true)}${stat(`${r.gwRank}<span style="font-size:13px;color:#5A6B85">/${r.gwOf}</span>`, "THIS WEEK")}${stat(String(r.periodPts), "POINTS · " + esc(r.periodLabel))}${stat(`${r.periodRank}<span style="font-size:13px;color:#5A6B85">/${r.periodOf}</span>`, "PERIOD RANK")}</tr></table></td></tr>
${sec("YOUR TEAM", `<table width="100%" cellpadding="0" cellspacing="0">${mine}</table>`)}
${sec("THE TABLE · " + esc(r.periodLabel), `<table width="100%" cellpadding="0" cellspacing="0"><tr style="font-size:11px;font-weight:700;color:#5A6B85"><td></td><td style="padding:0 6px 4px">GAFFER AND GW${r.gw} PICKS</td><td align="right" style="padding:0 6px 4px">GW</td><td align="right" style="padding:0 6px 4px">PERIOD</td></tr>${table}</table>`)}
${r.top.length ? sec("TOP SCORERS THIS WEEK", `<table width="100%" cellpadding="0" cellspacing="0">${top}</table>`) : ""}
<tr><td style="padding:22px 28px 0">${nxt}</td></tr>
<tr><td align="center" style="padding:20px 28px 26px"><a href="${esc(siteUrl)}" style="display:inline-block;background:#1F4E9C;color:#fff;font-weight:800;font-size:15px;text-decoration:none;padding:14px 28px;border-radius:12px">${r.next && r.next.picked < 4 ? "Make your picks" : "Open OnePick"}</a></td></tr>
<tr><td style="background:#F2F5FA;padding:16px 28px;font-size:11px;color:#5A6B85;line-height:1.5">OnePick is an unofficial fan game, not affiliated with the Premier League. You're getting this because you have an account. <a href="${esc(unsubUrl)}" style="color:#1F4E9C">Unsubscribe from these emails</a>.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `OnePick · Gameweek ${r.gw} results`, "", `Hi ${r.username}. You scored ${r.gwPts} this week (#${r.gwRank} of ${r.gwOf}).`, `${r.periodLabel}: ${r.periodPts} pts, #${r.periodRank} of ${r.periodOf}.`, "",
    "YOUR TEAM", ...(r.picks.length ? r.picks.map((p) => `  ${p.slot}  ${p.name} (${p.team})  ${p.pts}${p.note ? "  " + p.note : ""}`) : ["  No picks this gameweek"]), "",
    `THE TABLE · ${r.periodLabel}`, ...r.table.map((t) => `  ${t.rank}. ${t.name}${t.you ? " (you)" : ""}  +${t.gwPts}  total ${t.periodPts}\n     ${t.picks.length ? t.picks.map((p) => `${p.name} ${p.pts}`).join(", ") : "No picks"}`), "",
    ...(r.top.length ? ["TOP SCORERS", ...r.top.map((t) => `  ${t.pos}  ${t.name} (${t.team})  ${t.pts}`), ""] : []),
    ...(r.next ? [`Gameweek ${r.next.gw} picks lock ${deadlineText(r.next.deadline)}. ${r.next.picked}/4 picked.`, ""] : []),
    `Open OnePick: ${siteUrl}`, `Unsubscribe: ${unsubUrl}`,
  ].join("\n");
  return { subject, html, text };
}

/** Which gameweek, if any, has just settled and is still fresh enough to report on. */
export function settledGameweek(gws: { id: number; deadline_at: string }[], kicks: { gameweek_id: number; kickoff_at: string | null }[], now: Date): number | null {
  const last = new Map<number, number>();
  for (const k of kicks) if (k.gameweek_id != null && k.kickoff_at) last.set(k.gameweek_id, Math.max(last.get(k.gameweek_id) ?? 0, new Date(k.kickoff_at).getTime()));
  let best: number | null = null;
  for (const g of gws) {
    const l = last.get(g.id); if (!l) continue;
    const age = now.getTime() - (l + SETTLE_HOURS * 3600e3);
    if (age >= 0 && age < MAX_AGE_HOURS * 3600e3 && (best === null || g.id > best)) best = g.id;
  }
  return best;
}

export async function runResults(db: SupabaseClient, mail: Mailer, now: Date, opt: DigestOptions): Promise<DigestResult> {
  const [gws, kicks] = await Promise.all([rows(db, "gameweeks", "id, deadline_at"), rows(db, "fixtures", "gameweek_id, kickoff_at")]);
  // test mode: use the latest gameweek whose deadline has passed, even if it has not settled yet
  const gw = opt.testTo ? ([...gws].filter((g) => new Date(g.deadline_at).getTime() <= now.getTime()).sort((a, b) => b.id - a.id)[0]?.id ?? null) : settledGameweek(gws, kicks, now);
  if (gw == null) return { gameweek: null, sent: 0, skipped: 0, failed: 0 };

  const [official] = await rows(db, "leagues", "id, round_type, round_length", (q) => q.eq("is_official", true));
  if (!official) return { gameweek: gw, sent: 0, skipped: 0, failed: 0 };
  const roundLength = official.round_type === "gameweeks" && official.round_length ? official.round_length : 4;
  const { start } = periodRange(gw, roundLength);
  const nextG = gws.filter((g) => new Date(g.deadline_at).getTime() > now.getTime()).sort((a, b) => a.id - b.id)[0] ?? null;
  const wanted: number[] = []; for (let i = start; i <= Math.max(gw, nextG?.id ?? gw); i++) wanted.push(i);

  const [teams, players, picks, points, profiles, prefs, logged, users] = await Promise.all([
    rows(db, "teams", "id, short_name"), rows(db, "players", "id, web_name, team_id, position"),
    rows(db, "league_picks", "user_id, gameweek_id, player_id, slot", (q) => q.eq("league_id", official.id).in("gameweek_id", wanted)),
    rows(db, "player_gw_points", "player_id, gameweek_id, points, breakdown", (q) => q.in("gameweek_id", wanted.filter((g) => g <= gw))),
    rows(db, "profiles", "id, username"), rows(db, "digest_prefs", "user_id, enabled, token"),
    rows(db, "digest_log", "user_id, kind", (q) => q.eq("gameweek_id", gw)), listUsers(db),
  ]);
  const done = new Set(opt.testTo ? [] : logged.filter((r) => r.kind === "results").map((r) => r.user_id));
  const pref = new Map(prefs.map((p) => [p.user_id, p]));
  const todo = users.filter((u) => (opt.testTo ? u.email.toLowerCase() === opt.testTo.toLowerCase() : !done.has(u.id) && pref.get(u.id)?.enabled !== false));
  const skipped = users.length - todo.length;
  const fresh = todo.filter((u) => !pref.get(u.id));
  if (fresh.length && !opt.dryRun && !opt.testTo) {
    await upsertChunked(db, "digest_prefs", fresh.map((u) => ({ user_id: u.id })), "user_id");
    for (const p of await rows(db, "digest_prefs", "user_id, enabled, token")) pref.set(p.user_id, p);
  }
  const inp: ResultsInputs = { gw, roundLength, next: nextG ? { gw: nextG.id, deadline: nextG.deadline_at } : null, teams, players, picks, points, usernames: Object.fromEntries(profiles.map((p) => [p.id, p.username])) };
  const base = opt.siteUrl.replace(/\/$/, "");
  let sent = 0, failed = 0;
  for (const u of todo) {
    const token = pref.get(u.id)?.token;
    if (!token && !opt.dryRun && !opt.testTo) { failed++; console.error(`no unsubscribe token for ${u.id}`); continue; }
    const unsub = `${base}/#unsubscribe=${token ?? "preview"}`;
    const e = renderResults(buildResults(inp, u.id), base, unsub);
    try {
      if (opt.dryRun) console.log(`[dry run] would email ${u.email}: ${e.subject}`);
      else {
        await mail({ to: u.email, ...e, headers: { "List-Unsubscribe": `<${unsub}>` } });
        if (!opt.testTo) await upsertChunked(db, "digest_log", [{ gameweek_id: gw, user_id: u.id, kind: "results" }], "gameweek_id,user_id,kind");
      }
      sent++;
    } catch (err) { failed++; console.error(`results email to ${u.id} failed: ${(err as Error).message}`); }
  }
  return { gameweek: gw, sent, skipped, failed };
}
