import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveSteamId } from "./ids";
import { shapeAchievements, shapeAppDetails, shapeOwnedGames, stripHtml } from "./shape";
import { SteamError, steamGet, storeGet } from "./steam";

export interface Env {
  STEAM_API_KEY: string;
  GATEWAY_SECRET?: string;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

/** Wrap a handler so Steam errors become readable tool errors instead of protocol errors. */
function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e instanceof SteamError ? e.message : `Unexpected error: ${(e as Error).message}`);
    }
  };
}

const player = z.string().describe("SteamID64, profile URL, or custom URL name (e.g. 'gabelogannewell')");
const appid = z.number().int().positive().describe("Steam app ID, e.g. 570 for Dota 2");
const readOnly = { readOnlyHint: true, openWorldHint: true };

export function buildServer(env: Env): McpServer {
  const key = env.STEAM_API_KEY;
  const server = new McpServer({ name: "steam-mcp", version: "0.1.0" });
  const id = (p: string) => resolveSteamId(key, p);

  // ---------- Players ----------

  server.registerTool(
    "resolve_vanity_url",
    {
      description: "Turn a Steam custom profile URL/name into a SteamID64.",
      inputSchema: z.object({ player }),
      annotations: readOnly,
    },
    safe(async ({ player }) => ({ steamid: await id(player) })),
  );

  server.registerTool(
    "get_player_summaries",
    {
      description: "Public profile info (name, avatar, online state, current game, country, account age) for up to 100 players.",
      inputSchema: z.object({ players: z.array(player).min(1).max(100) }),
      annotations: readOnly,
    },
    safe(async ({ players }) => {
      const ids = await Promise.all(players.map(id));
      const data = await steamGet(key, "ISteamUser", "GetPlayerSummaries", 2, { steamids: ids.join(",") });
      const states = ["offline", "online", "busy", "away", "snooze", "looking to trade", "looking to play"];
      return (data?.response?.players ?? []).map((p: any) => ({
        steamid: p.steamid,
        name: p.personaname,
        profile_url: p.profileurl,
        avatar: p.avatarfull,
        public: p.communityvisibilitystate === 3,
        state: states[p.personastate] ?? p.personastate,
        playing: p.gameextrainfo ? { name: p.gameextrainfo, appid: Number(p.gameid) } : undefined,
        real_name: p.realname,
        country: p.loccountrycode,
        created: p.timecreated ? new Date(p.timecreated * 1000).toISOString().slice(0, 10) : undefined,
        last_logoff: p.lastlogoff ? new Date(p.lastlogoff * 1000).toISOString() : undefined,
      }));
    }),
  );

  server.registerTool(
    "get_friend_list",
    {
      description: "A player's friends (SteamIDs + since-date). Fails if the friend list is private. Use get_player_summaries for names.",
      inputSchema: z.object({ player }),
      annotations: readOnly,
    },
    safe(async ({ player }) => {
      const data = await steamGet(key, "ISteamUser", "GetFriendList", 1, { steamid: await id(player), relationship: "friend" });
      const friends = data?.friendslist?.friends ?? [];
      return {
        count: friends.length,
        friends: friends.map((f: any) => ({ steamid: f.steamid, since: new Date(f.friend_since * 1000).toISOString().slice(0, 10) })),
      };
    }),
  );

  server.registerTool(
    "get_player_bans",
    {
      description: "VAC, game, community and trade ban status for up to 100 players.",
      inputSchema: z.object({ players: z.array(player).min(1).max(100) }),
      annotations: readOnly,
    },
    safe(async ({ players }) => {
      const ids = await Promise.all(players.map(id));
      const data = await steamGet(key, "ISteamUser", "GetPlayerBans", 1, { steamids: ids.join(",") });
      return data?.players ?? [];
    }),
  );

  server.registerTool(
    "get_owned_games",
    {
      description:
        "A player's game library with playtime. Trimmed: returns totals plus up to `limit` games ordered by `sort`, starting at `offset`. If `next_offset` is present in the result, call again with that offset to get the next page. Requires public game details.",
      inputSchema: z.object({
        player,
        sort: z.enum(["playtime", "recent", "backlog", "name"]).default("playtime"),
        limit: z.number().int().min(1).max(5000).default(50).describe("Max games to return (default 50). Raise it to pull more in one call; use offset to page."),
        offset: z.number().int().min(0).default(0).describe("Skip this many games (in `sort` order) — use next_offset from the previous page"),
        include_free_games: z.boolean().default(false).describe("Include free-to-play games the player has launched"),
      }),
      annotations: readOnly,
    },
    safe(async ({ player, sort, limit, offset, include_free_games }) => {
      const data = await steamGet(key, "IPlayerService", "GetOwnedGames", 1, {
        steamid: await id(player),
        include_appinfo: true,
        include_played_free_games: include_free_games,
      });
      return shapeOwnedGames(data, sort, limit, offset);
    }),
  );

  server.registerTool(
    "get_recently_played_games",
    {
      description: "Games a player played in the last two weeks, with hours.",
      inputSchema: z.object({ player, count: z.number().int().min(1).max(50).optional() }),
      annotations: readOnly,
    },
    safe(async ({ player, count }) => {
      const data = await steamGet(key, "IPlayerService", "GetRecentlyPlayedGames", 1, { steamid: await id(player), count });
      return (data?.response?.games ?? []).map((g: any) => ({
        appid: g.appid,
        name: g.name,
        hours_2weeks: +(g.playtime_2weeks / 60).toFixed(1),
        hours_total: +(g.playtime_forever / 60).toFixed(1),
      }));
    }),
  );

  server.registerTool(
    "get_steam_level",
    {
      description: "A player's Steam level.",
      inputSchema: z.object({ player }),
      annotations: readOnly,
    },
    safe(async ({ player }) => {
      const data = await steamGet(key, "IPlayerService", "GetSteamLevel", 1, { steamid: await id(player) });
      return { level: data?.response?.player_level ?? null };
    }),
  );

  server.registerTool(
    "get_player_achievements",
    {
      description: "A player's achievements for one game, with unlock dates. Requires public game details.",
      inputSchema: z.object({
        player,
        appid,
        only_locked: z.boolean().default(false).describe("Only return achievements not yet unlocked"),
        language: z.string().default("english"),
      }),
      annotations: readOnly,
    },
    safe(async ({ player, appid, only_locked, language }) => {
      try {
        const data = await steamGet(key, "ISteamUserStats", "GetPlayerAchievements", 1, { steamid: await id(player), appid, l: language });
        return shapeAchievements(data, only_locked);
      } catch (e) {
        // This endpoint answers 400 with a JSON body for private profiles / games without stats.
        if (e instanceof SteamError && e.status === 400) return { error: "Profile is private, or this game has no achievements." };
        throw e;
      }
    }),
  );

  // ---------- Games ----------

  server.registerTool(
    "search_store",
    {
      description: "Search the Steam store by name to find app IDs and current prices.",
      inputSchema: z.object({
        term: z.string().min(1),
        country: z.string().length(2).default("us").describe("Two-letter country code for pricing"),
      }),
      annotations: readOnly,
    },
    safe(async ({ term, country }) => {
      const data = await storeGet("api/storesearch/", { term, cc: country, l: "english" });
      return (data?.items ?? []).map((i: any) => ({
        appid: i.id,
        name: i.name,
        type: i.type,
        price: i.price ? { currency: i.price.currency, final: i.price.final / 100, initial: i.price.initial / 100 } : "free or unavailable",
        metascore: i.metascore || undefined,
        platforms: i.platforms,
      }));
    }),
  );

  server.registerTool(
    "get_app_details",
    {
      description: "Store page details for a game: description, price, genres, release date, developers, platforms, metacritic.",
      inputSchema: z.object({ appid, country: z.string().length(2).default("us") }),
      annotations: readOnly,
    },
    safe(async ({ appid, country }) => {
      const data = await storeGet("api/appdetails", { appids: appid, cc: country, l: "english" });
      return shapeAppDetails(data, appid);
    }),
  );

  server.registerTool(
    "get_current_players",
    {
      description: "Number of players in a game right now.",
      inputSchema: z.object({ appid }),
      annotations: readOnly,
    },
    safe(async ({ appid }) => {
      const data = await steamGet(key, "ISteamUserStats", "GetNumberOfCurrentPlayers", 1, { appid });
      return { appid, player_count: data?.response?.player_count ?? null };
    }),
  );

  server.registerTool(
    "get_global_achievement_percentages",
    {
      description: "Percentage of all players who unlocked each achievement in a game (rarest last).",
      inputSchema: z.object({ appid }),
      annotations: readOnly,
    },
    safe(async ({ appid }) => {
      const data = await steamGet(key, "ISteamUserStats", "GetGlobalAchievementPercentagesForApp", 2, { gameid: appid });
      return (data?.achievementpercentages?.achievements ?? []).map((a: any) => ({ api_name: a.name, percent: +Number(a.percent).toFixed(2) }));
    }),
  );

  server.registerTool(
    "get_game_schema",
    {
      description: "A game's achievement and stat definitions (display names, descriptions, hidden flag).",
      inputSchema: z.object({ appid, language: z.string().default("english") }),
      annotations: readOnly,
    },
    safe(async ({ appid, language }) => {
      const data = await steamGet(key, "ISteamUserStats", "GetSchemaForGame", 2, { appid, l: language });
      const g = data?.game ?? {};
      return {
        name: g.gameName,
        achievements: (g.availableGameStats?.achievements ?? []).map((a: any) => ({
          api_name: a.name,
          name: a.displayName,
          description: a.description,
          hidden: a.hidden === 1,
        })),
        stats: (g.availableGameStats?.stats ?? []).map((s: any) => s.displayName || s.name),
      };
    }),
  );

  server.registerTool(
    "get_app_news",
    {
      description: "Latest news posts and patch notes for a game.",
      inputSchema: z.object({ appid, count: z.number().int().min(1).max(20).default(5) }),
      annotations: readOnly,
    },
    safe(async ({ appid, count }) => {
      const data = await steamGet(key, "ISteamNews", "GetNewsForApp", 2, { appid, count, maxlength: 0 });
      return (data?.appnews?.newsitems ?? []).map((n: any) => ({
        title: n.title,
        date: new Date(n.date * 1000).toISOString().slice(0, 10),
        url: n.url,
        feed: n.feedlabel,
        contents: stripHtml(n.contents ?? ""),
      }));
    }),
  );

  server.registerTool(
    "get_app_list",
    {
      description: "Page through every app on the Steam store (appid, name, last modified). Use search_store to find one game by name.",
      inputSchema: z.object({
        last_appid: z.number().int().min(0).default(0).describe("Continue after this appid (from previous page)"),
        max_results: z.number().int().min(1).max(5000).default(1000),
        include_dlc: z.boolean().default(false),
      }),
      annotations: readOnly,
    },
    safe(async ({ last_appid, max_results, include_dlc }) => {
      const data = await steamGet(key, "IStoreService", "GetAppList", 1, {
        last_appid,
        max_results,
        include_games: true,
        include_dlc,
      });
      const r = data?.response ?? {};
      return {
        apps: (r.apps ?? []).map((a: any) => ({ appid: a.appid, name: a.name })),
        have_more_results: !!r.have_more_results,
        last_appid: r.last_appid,
      };
    }),
  );

  // ---------- Escape hatch ----------

  server.registerTool(
    "call_steam_api",
    {
      description:
        "Call any GET method on api.steampowered.com when no dedicated tool fits, e.g. interface='ISteamUserStats', method='GetUserStatsForGame', version=2. The API key is added automatically. Returns raw JSON (truncated at 20k chars).",
      inputSchema: z.object({
        interface: z.string().regex(/^I[A-Za-z0-9_]+$/),
        method: z.string().regex(/^[A-Za-z0-9_]+$/),
        version: z.number().int().min(1).max(9).default(1),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      }),
      annotations: readOnly,
    },
    async ({ interface: iface, method, version, params }) => {
      try {
        const { key: _drop, ...rest } = params; // never let the caller override the key
        const text = JSON.stringify(await steamGet(key, iface, method, version, rest));
        return { content: [{ type: "text" as const, text: text.length > 20_000 ? text.slice(0, 20_000) + "…[truncated]" : text }] };
      } catch (e) {
        return fail(e instanceof SteamError ? e.message : `Unexpected error: ${(e as Error).message}`);
      }
    },
  );

  return server;
}
