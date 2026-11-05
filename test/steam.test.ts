import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSteamId } from "../src/ids";
import { rankOwnedGames, shapeAchievements, shapeAppDetails, shapeOwnedGames, stripHtml } from "../src/shape";
import { SteamError, steamGet } from "../src/steam";

const KEY = "TESTKEY";

function mockFetch(status: number, body: unknown) {
  const spy = vi.fn(async (_url: URL | string | Request, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("steamGet", () => {
  it("injects key and format, builds the right URL", async () => {
    const spy = mockFetch(200, { response: {} });
    await steamGet(KEY, "ISteamUser", "GetPlayerSummaries", 2, { steamids: "1,2", flag: true, skip: undefined });
    const url = new URL(spy.mock.calls[0]![0] as URL);
    expect(url.origin + url.pathname).toBe("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
    expect(url.searchParams.get("key")).toBe(KEY);
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("flag")).toBe("1");
    expect(url.searchParams.has("skip")).toBe(false);
  });

  it("turns 401 into a readable private/invalid-key error", async () => {
    mockFetch(401, "Unauthorized");
    await expect(steamGet(KEY, "IPlayerService", "GetOwnedGames", 1)).rejects.toThrow(/private|API key/);
  });

  it("never leaks the key in error messages", async () => {
    mockFetch(500, `boom key=${KEY}`);
    const err = await steamGet(KEY, "X", "Y", 1).catch((e) => e as SteamError);
    expect(err).toBeInstanceOf(SteamError);
    expect(err.status).toBe(500);
  });

  it("refuses to run without a key", async () => {
    await expect(steamGet("", "X", "Y", 1)).rejects.toThrow(/STEAM_API_KEY/);
  });
});

describe("resolveSteamId", () => {
  it("passes through a SteamID64 without a network call", async () => {
    const spy = mockFetch(200, {});
    expect(await resolveSteamId(KEY, " 76561197960435530 ")).toBe("76561197960435530");
    expect(spy).not.toHaveBeenCalled();
  });

  it("extracts the id from a /profiles/ URL", async () => {
    expect(await resolveSteamId(KEY, "https://steamcommunity.com/profiles/76561197960435530/games")).toBe("76561197960435530");
  });

  it("resolves /id/ URLs and bare names via ResolveVanityURL", async () => {
    const spy = mockFetch(200, { response: { success: 1, steamid: "76561197960287930" } });
    expect(await resolveSteamId(KEY, "https://steamcommunity.com/id/gabelogannewell/")).toBe("76561197960287930");
    expect(await resolveSteamId(KEY, "gabelogannewell")).toBe("76561197960287930");
    for (const call of spy.mock.calls) expect(new URL(call[0] as URL).searchParams.get("vanityurl")).toBe("gabelogannewell");
  });

  it("errors clearly on unknown vanity names", async () => {
    mockFetch(200, { response: { success: 42, message: "No match" } });
    await expect(resolveSteamId(KEY, "nobody-here")).rejects.toThrow(/Could not resolve/);
  });
});

describe("shape", () => {
  it("flags private libraries", () => {
    expect(shapeOwnedGames({ response: {} }, "playtime", 10)).toMatchObject({ private_or_empty: true });
  });

  it("summarises owned games and respects limit", () => {
    const games = [
      { appid: 1, name: "A", playtime_forever: 600, rtime_last_played: 0 },
      { appid: 2, name: "B", playtime_forever: 0, rtime_last_played: 0 },
      { appid: 3, name: "C", playtime_forever: 30, playtime_2weeks: 30, rtime_last_played: 1_700_000_000 },
    ];
    const out = shapeOwnedGames({ response: { game_count: 3, games } }, "playtime", 2);
    expect(out).toMatchObject({ game_count: 3, never_played: 1, total_hours: 11, showing: 2 });
  });

  it("handles achievement failures and locked filter", () => {
    expect(shapeAchievements({ playerstats: { success: false, error: "Profile is not public" } }, false)).toEqual({ error: "Profile is not public" });
    const out = shapeAchievements(
      { playerstats: { success: true, gameName: "G", achievements: [{ apiname: "a", achieved: 1, unlocktime: 1_700_000_000 }, { apiname: "b", achieved: 0 }] } },
      true,
    );
    expect(out).toMatchObject({ unlocked: 1, total: 2 });
    expect(out.achievements).toHaveLength(1);
    expect(out.achievements![0]).toMatchObject({ api_name: "b", unlocked: false });
  });

  it("shapes app details and missing apps", () => {
    expect(shapeAppDetails({ 1: { success: false } }, 1)).toHaveProperty("error");
    const out = shapeAppDetails({ 1145360: { success: true, data: { name: "Hades", price_overview: { final_formatted: "$24.99", discount_percent: 0 }, genres: [{ description: "Action" }] } } }, 1145360);
    expect(out).toMatchObject({ name: "Hades", price: { final: "$24.99" }, genres: ["Action"] });
  });

  it("strips html and bbcode", () => {
    expect(stripHtml("<p>Hi</p> [b]there[/b] [url=http://x]link[/url]")).toBe("Hi there link");
  });
});

describe("rankOwnedGames", () => {
  const games = [
    { appid: 10, name: "beta", playtime_forever: 0, rtime_last_played: 0 },
    { appid: 20, name: "Alpha", playtime_forever: 500, rtime_last_played: 100 },
    { appid: 30, name: "gamma", playtime_forever: 30, rtime_last_played: 300 },
    { appid: 40, playtime_forever: 0, rtime_last_played: 0 },
    { appid: 50, name: "delta", playtime_forever: 59, rtime_last_played: 200 },
  ];
  const ids = (g: { appid: number }[]) => g.map((x) => x.appid);

  it("playtime: most played first, ties by appid", () => {
    expect(ids(rankOwnedGames(games, "playtime", 10))).toEqual([20, 50, 30, 10, 40]);
  });
  it("recent: last played first, never-played last", () => {
    expect(ids(rankOwnedGames(games, "recent", 10))).toEqual([30, 50, 20, 10, 40]);
  });
  it("backlog: under 60 min only, never-launched first, newer appid first", () => {
    expect(ids(rankOwnedGames(games, "backlog", 10))).toEqual([40, 10, 50, 30]);
  });
  it("name: case-insensitive A-Z, missing name falls back to appid", () => {
    expect(ids(rankOwnedGames(games, "name", 10))).toEqual([40, 20, 10, 50, 30]);
  });
  it("respects limit and does not mutate input", () => {
    const before = ids(games);
    expect(rankOwnedGames(games, "playtime", 2)).toHaveLength(2);
    expect(ids(games)).toEqual(before);
  });
});
