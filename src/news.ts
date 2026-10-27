import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient, upsertChunked } from "./db.js";
import { getProvider } from "./provider.js";
import type { DataProvider } from "./types.js";

/* Team news: (1) the official injury notes already inside the FPL feed (refreshed into the players table), and
   (2) headlines from public news RSS feeds that mention a club's injuries, suspensions or likely line-up.
   We store the headline, a short snippet and the link, nothing else, and the website links back to the source.
   Every source is optional: if one is down or changes address, the others still work and the log says which. */

export interface FeedSource { name: string; url: string }
export const SOURCES: FeedSource[] = [
  { name: "BBC Sport", url: "https://feeds.bbci.co.uk/sport/football/rss.xml" },
  { name: "The Guardian", url: "https://www.theguardian.com/football/rss" },
  { name: "Sky Sports", url: "https://www.skysports.com/rss/12040" },
  { name: "Fantasy Football Scout", url: "https://www.fantasyfootballscout.co.uk/feed/" },
  { name: "Football365", url: "https://www.football365.com/feed" },
  { name: "talkSPORT", url: "https://talksport.com/football/feed/" },
  { name: "The Independent", url: "https://www.independent.co.uk/sport/football/rss" },
];

/** Optional override from the environment: NEWS_FEEDS="Name|https://url,Name2|https://url2" */
export function configuredSources(env: string | undefined = process.env.NEWS_FEEDS): FeedSource[] {
  if (!env) return SOURCES;
  const list = env.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [name, url] = x.split("|"); return { name: (name ?? "").trim(), url: (url ?? "").trim() }; })
    .filter((s) => s.name && /^https?:\/\//.test(s.url));
  return list.length ? list : SOURCES;
}

/* ---------- parsing ---------- */
export interface RawItem { title: string; url: string; summary: string; published: Date | null }

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&#x27;": "'", "&nbsp;": " ", "&#8217;": "'", "&#8216;": "'", "&#8220;": '"', "&#8221;": '"', "&#8211;": "-", "&#8212;": "-" };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m) => ENT[m.toLowerCase()] ?? (m.startsWith("&#") ? String.fromCodePoint(m[2]?.toLowerCase() === "x" ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10) || 32) : m));
const strip = (s: string) => decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (block: string, name: string) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1] : ""; };

/** Reads RSS 2.0 (<item>) and Atom (<entry>). Anything it can't make sense of is skipped. */
export function parseFeed(xml: string): RawItem[] {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const out: RawItem[] = [];
  for (const b of blocks) {
    const title = strip(tag(b, "title"));
    let url = strip(tag(b, "link"));
    if (!url) { const m = b.match(/<link[^>]*href=["']([^"']+)["']/i); url = m ? decode(m[1]) : strip(tag(b, "guid")); }
    if (!title || !/^https?:\/\//.test(url)) continue;
    const when = strip(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"));
    const d = when ? new Date(when) : null;
    out.push({ title, url, summary: strip(tag(b, "description") || tag(b, "summary") || tag(b, "content:encoded")).slice(0, 240), published: d && !isNaN(d.getTime()) ? d : null });
  }
  return out;
}

/* ---------- classifying and matching ---------- */
const INJURY = /\b(injur\w*|fitness|fitness test|doubt\w*|ruled out|out for|sidelined|knock|hamstring|ankle|calf|groin|thigh|knee|illness|setback|back in training|scan|surgery|will miss|set to miss|misses|suspen\w*|banned|red card|available again|return\w* (from|to)|fit again)\b/i;
const LINEUP = /\b(team news|line-?ups?|starting (xi|eleven|11)|predicted (xi|team|line-?up)|expected (xi|team|line-?up)|probable (xi|team)|confirmed (xi|team|line-?up)|rotat\w*|benched|dropped|names? (an )?unchanged|team changes)\b/i;
const STRONG = /\b(injur\w*|ruled out|doubt\w*|team news|predicted (xi|team|line-?up)|expected (xi|team|line-?up)|starting (xi|eleven|11)|suspen\w*|will miss|set to miss)\b/i;
export const classify = (text: string): "injury" | "lineup" | "news" => (LINEUP.test(text) ? "lineup" : INJURY.test(text) ? "injury" : "news");

const EXTRA_NAMES: Record<string, string[]> = {
  "Man City": ["Manchester City"], "Man Utd": ["Manchester United", "Man United"], "Spurs": ["Tottenham"], "Nott'm Forest": ["Nottingham Forest"],
  "Wolves": ["Wolverhampton"], "Newcastle": ["Newcastle United"], "Leeds": ["Leeds United"], "West Ham": ["West Ham United"],
  "Brighton": ["Brighton & Hove Albion", "Brighton and Hove Albion"], "Bournemouth": ["AFC Bournemouth"], "Villa": ["Aston Villa"],
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (names: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(${names.map(esc).join("|")})(?![\\p{L}\\p{N}])`, "iu");

export function matchTeams(text: string, teams: { id: number; name: string }[]): number[] {
  return teams.filter((t) => wordRe([t.name, ...(EXTRA_NAMES[t.name] ?? [])]).test(text)).map((t) => t.id);
}
export function matchPlayers(text: string, players: { id: number; web_name: string; team_id: number }[], teamIds: number[]): number[] {
  const counts = new Map<string, number>(); players.forEach((p) => counts.set(p.web_name.toLowerCase(), (counts.get(p.web_name.toLowerCase()) ?? 0) + 1));
  return players.filter((p) => p.web_name.length >= 5 && counts.get(p.web_name.toLowerCase()) === 1 && (teamIds.includes(p.team_id) || p.web_name.length >= 7) && wordRe([p.web_name]).test(text)).map((p) => p.id);
}

export interface NewsRow { source: string; title: string; summary: string | null; url: string; published_at: string; team_ids: number[]; player_ids: number[]; kind: "injury" | "lineup" }

/** Keeps only headlines that are about injuries or line-ups AND name at least one Premier League club. */
export function toRows(source: string, items: RawItem[], teams: { id: number; name: string }[], players: { id: number; web_name: string; team_id: number }[], now = new Date()): NewsRow[] {
  const rows: NewsRow[] = [];
  for (const it of items) {
    const text = it.title + " " + it.summary;
    // the headline decides; the snippet only counts when it clearly says so (this keeps transfer gossip out)
    const kind = classify(it.title) !== "news" ? classify(it.title) : STRONG.test(it.summary) ? classify(it.summary) : "news";
    if (kind === "news") continue;
    const team_ids = matchTeams(it.title, teams).length ? matchTeams(it.title, teams) : matchTeams(text, teams);
    if (!team_ids.length) continue;
    const published = it.published && it.published.getTime() <= now.getTime() + 3600000 ? it.published : now;
    rows.push({ source, title: it.title.slice(0, 220), summary: it.summary || null, url: it.url, published_at: published.toISOString(), team_ids, player_ids: matchPlayers(text, players, team_ids), kind });
  }
  return rows;
}

/* ---------- the job ---------- */
export type Fetcher = (url: string) => Promise<string>;
const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; onepick-prototype/0.1)", Accept: "application/rss+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
};

export async function runNews(db: SupabaseClient, provider: DataProvider, fetcher: Fetcher = defaultFetcher, sources: FeedSource[] = configuredSources(), now = new Date()) {
  // 1. official availability notes: status, news text and chance of playing come with the player list
  const stat = await provider.fetchStatic();
  await upsertChunked(db, "players", stat.players.map((p) => ({ ...p, active: true, updated_at: now.toISOString() })), "id");

  // 2. headlines
  const perSource: Record<string, string> = {}; const all: NewsRow[] = [];
  for (const s of sources) {
    try {
      const items = parseFeed(await fetcher(s.url));
      const rows = toRows(s.name, items, stat.teams, stat.players, now);
      perSource[s.name] = `${items.length} items, ${rows.length} relevant`; all.push(...rows);
    } catch (e) { perSource[s.name] = "failed: " + (e instanceof Error ? e.message : String(e)); }
  }
  const unique = [...new Map(all.map((r) => [r.url, r])).values()];
  if (unique.length) await upsertChunked(db, "team_news", unique, "url");
  // tidy up: nothing older than three weeks is shown
  const cutoff = new Date(now.getTime() - 21 * 86400000).toISOString();
  const { error } = await (db.from("team_news") as any).delete().lt("published_at", cutoff);
  if (error) console.warn("news cleanup:", error.message);
  return { players: stat.players.length, headlines: unique.length, perSource };
}

if (process.argv[1]?.endsWith("news.ts")) {
  runNews(serviceClient(), getProvider())
    .then((r) => console.log("News updated:", JSON.stringify(r, null, 1)))
    .catch((e) => { console.error(e); process.exit(1); });
}
