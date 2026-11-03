import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSteamId } from "../src/ids";
import { shapeAchievements, shapeAppDetails, shapeOwnedGames, stripHtml } from "../src/shape";
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

  it("paginates owned games with offset / next_offset", () => {
    const games = Array.from({ length: 5 }, (_, i) => ({ appid: i + 1, name: `G${i}`, playtime_forever: i, rtime_last_played: 0 }));
    const raw = { response: { game_count: 5, games } };
    const p1 = shapeOwnedGames(raw, "playtime", 2, 0) as any;
    const p2 = shapeOwnedGames(raw, "playtime", 2, p1.next_offset) as any;
    const p3 = shapeOwnedGames(raw, "playtime", 2, p2.next_offset) as any;
    expect([p1.showing, p2.showing, p3.showing]).toEqual([2, 2, 1]);
    expect(p3.next_offset).toBeUndefined();
    const ids = [...p1.games, ...p2.games, ...p3.games].map((g: any) => g.appid);
    expect(new Set(ids).size).toBe(5);
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
