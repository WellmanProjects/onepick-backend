import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const A = "aaaaaaaa-0000-0000-0000-000000000001", B = "bbbbbbbb-0000-0000-0000-000000000002";
let db: PGlite;

const as = async (uid: string | null, fn: () => Promise<unknown>) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`);
  try { return await fn(); } finally { await db.exec("reset role;"); }
};
const fails = async (p: Promise<unknown>, msg: RegExp) => { await expect(p).rejects.toThrow(msg); };

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
  `);
  await db.exec(readFileSync(new URL("../supabase/migrations/001_schema.sql", import.meta.url), "utf8"));
  await db.exec(`
    insert into teams values (1,'Arsenal','ARS',3),(2,'Man City','MCI',43);
    insert into players (id, web_name, team_id, position) values (10,'Saka',1,'MID'),(11,'Haaland',2,'FWD'),(12,'Raya',1,'GK'),(13,'Rice',1,'MID');
    -- GW1-2 locked (past deadlines, GW1 in August, GW2 in September); GW3-4 open
    insert into gameweeks (id, name, deadline_at, month_key) values
      (1,'GW1', now() - interval '30 days', '2026-08'), (2,'GW2', now() - interval '20 days', '2026-09'),
      (3,'GW3', now() + interval '5 days',  '2026-09'), (4,'GW4', now() + interval '12 days', '2026-10');
    insert into player_gw_points (player_id, gameweek_id, points, provisional) values (11,1,12,false),(10,1,5,false),(10,2,7,false),(11,2,2,false);
    insert into auth.users (id, raw_user_meta_data) values ('${A}', '{"username":"alice"}'), ('${B}', '{"username":"bob"}');
  `);
});

describe("accounts", () => {
  it("creates a profile when a user signs up", async () => {
    const r = await db.query<{ username: string }>("select username from profiles order by username");
    expect(r.rows.map((x) => x.username)).toEqual(["alice", "bob"]);
  });
});

describe("main picks", () => {
  it("lets you pick for an open gameweek", async () => {
    await as(A, () => db.query("insert into picks (user_id, gameweek_id, player_id) values ($1, 3, 11)", [A]));
  });
  it("blocks reusing a player in another gameweek", async () => {
    await as(A, () => fails(db.query("insert into picks (user_id, gameweek_id, player_id) values ($1, 4, 11)", [A]), /duplicate key/));
  });
  it("blocks a second pick in the same gameweek", async () => {
    await as(A, () => fails(db.query("insert into picks (user_id, gameweek_id, player_id) values ($1, 3, 10)", [A]), /duplicate key/));
  });
  it("allows changing and clearing a pick before the deadline", async () => {
    await as(A, async () => {
      await db.query("update picks set player_id = 10 where user_id = $1 and gameweek_id = 3", [A]);
      await db.query("delete from picks where user_id = $1 and gameweek_id = 3", [A]);
    });
  });
  it("blocks picks after the deadline", async () => {
    await as(A, () => fails(db.query("insert into picks (user_id, gameweek_id, player_id) values ($1, 1, 12)", [A]), /locked/));
  });
  it("blocks changing or deleting a pick once locked", async () => {
    await db.exec("select set_config('onepick.bypass_lock','on',false)");
    await db.query("insert into picks (user_id, gameweek_id, player_id) values ($1, 1, 11), ($1, 2, 10), ($2, 1, 10), ($2, 2, 11)", [A, B]);
    await db.exec("select set_config('onepick.bypass_lock','off',false)");
    await as(A, () => fails(db.query("update picks set player_id = 12 where user_id = $1 and gameweek_id = 1", [A]), /locked/));
    await as(A, () => fails(db.query("delete from picks where user_id = $1 and gameweek_id = 2", [A]), /locked/));
  });
  it("hides other people's picks until the deadline, then reveals them", async () => {
    await as(B, () => db.query("insert into picks (user_id, gameweek_id, player_id) values ($1, 3, 12)", [B]));
    const seenByA = await as(A, () => db.query<{ gameweek_id: number; user_id: string }>("select user_id, gameweek_id from picks where user_id = $1 order by 2", [B])) as any;
    expect(seenByA.rows.map((r: any) => r.gameweek_id)).toEqual([1, 2]);   // GW3 hidden
  });
  it("cannot write picks as someone else", async () => {
    await as(A, () => fails(db.query("insert into picks (user_id, gameweek_id, player_id) values ($1, 4, 13)", [B]), /row-level security/));
  });
});

describe("standings", () => {
  it("counts only locked gameweeks and ranks players", async () => {
    const r = await as(A, () => db.query<{ username: string; points: string; rank: string }>("select username, points, rank from standings(null)")) as any;
    // alice: GW1 Haaland 12 + GW2 Saka 7 = 19; bob: GW1 Saka 5 + GW2 Haaland 2 = 7 (GW3 not locked, not counted)
    expect(r.rows.map((x: any) => [x.username, Number(x.points), Number(x.rank)])).toEqual([["alice", 19, 1], ["bob", 7, 2]]);
  });
  it("can be limited to a round (GW2 only)", async () => {
    const r = await as(A, () => db.query("select username, points from standings(null, 2, 2)")) as any;
    expect(r.rows.map((x: any) => [x.username, Number(x.points)])).toEqual([["alice", 7], ["bob", 2]]);
  });
});

describe("leagues", () => {
  let code = "", lid = "", rid = "";
  it("creates a league with a share code and joins by code", async () => {
    const c = await as(A, () => db.query<{ id: string; code: string }>("select id, code from create_league('The Lads', 'gameweeks', 2, true)")) as any;
    lid = c.rows[0].id; code = c.rows[0].code;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    await as(B, () => db.query("select * from join_league($1)", [code.toLowerCase()]));
    const m = await as(A, () => db.query("select count(*)::int as n from league_members where league_id = $1", [lid])) as any;
    expect(m.rows[0].n).toBe(2);
  });
  it("rejects a bad code and hides leagues from non-members", async () => {
    await as(B, () => fails(db.query("select * from join_league('ZZZZZ')"), /No league found/));
    await db.exec("insert into auth.users (id, raw_user_meta_data) values ('cccccccc-0000-0000-0000-000000000003','{\"username\":\"carol\"}')");
    const r = await as("cccccccc-0000-0000-0000-000000000003", () => db.query("select * from leagues")) as any;
    expect(r.rows).toHaveLength(0);
  });
  it("rejects reset leagues that run for the whole season", async () => {
    await as(A, () => fails(db.query("select * from create_league('Bad', 'season', null, true)"), /check/));
  });
  it("puts gameweeks into the right round (blocks of 2 and monthly)", async () => {
    const r = await db.query<{ a: number; b: number; c: number }>(
      "select league_round_index($1, 1) a, league_round_index($1, 2) b, league_round_index($1, 3) c", [lid]);
    expect(r.rows[0]).toEqual({ a: 1, b: 1, c: 2 });
    await db.exec("insert into leagues (id, code, name, owner_id, round_type) values ('11111111-1111-1111-1111-111111111111','MMMMM','Monthly',  '" + A + "', 'monthly')");
    const m = await db.query<{ a: number; b: number; c: number }>(
      "select league_round_index('11111111-1111-1111-1111-111111111111',1) a, league_round_index('11111111-1111-1111-1111-111111111111',2) b, league_round_index('11111111-1111-1111-1111-111111111111',4) c");
    expect(m.rows[0]).toEqual({ a: 1, b: 2, c: 3 });
  });
  it("lets a reset league reuse a player in a new round but not inside one", async () => {
    await db.exec("select set_config('onepick.bypass_lock','on',false)");
    await db.query("insert into league_picks (league_id, user_id, gameweek_id, player_id) values ($1,$2,1,11)", [lid, A]);
    await db.exec("select set_config('onepick.bypass_lock','off',false)");
    // GW2 is in the same round as GW1 (locked anyway) -> use open GWs: GW3 is round 2, GW4 round 2
    await as(A, () => db.query("insert into league_picks (league_id, user_id, gameweek_id, player_id) values ($1,$2,3,11)", [lid, A]));   // Haaland again, new round: fine
    await as(A, () => fails(db.query("insert into league_picks (league_id, user_id, gameweek_id, player_id) values ($1,$2,4,11)", [lid, A]), /duplicate key/)); // same round: blocked
    const r = await db.query<{ round_index: number }>("select round_index from league_picks where gameweek_id = 3");
    expect(r.rows[0].round_index).toBe(2);
  });
  it("scores a reset league from its own picks", async () => {
    await db.exec("select set_config('onepick.bypass_lock','on',false)");
    await db.query("insert into league_picks (league_id, user_id, gameweek_id, player_id) values ($1,$2,1,10),($1,$2,2,11)", [lid, B]);
    await db.exec("select set_config('onepick.bypass_lock','off',false)");
    const r = await as(A, () => db.query("select username, points from standings($1)", [lid])) as any;
    // alice (league picks): GW1 Haaland 12; bob: GW1 Saka 5 + GW2 Haaland 2 = 7
    expect(r.rows.map((x: any) => [x.username, Number(x.points)])).toEqual([["alice", 12], ["bob", 7]]);
  });
  it("won't show a league table to a non-member", async () => {
    await as("cccccccc-0000-0000-0000-000000000003", () => fails(db.query("select * from standings($1)", [lid]), /Not a member/));
  });
});
