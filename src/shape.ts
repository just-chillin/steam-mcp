// Response trimming. Steam happily returns thousands of rows; an LLM context does not want them.

export interface OwnedGame {
  appid: number;
  name?: string;
  playtime_forever: number; // minutes
  playtime_2weeks?: number; // minutes
  rtime_last_played?: number; // unix seconds, 0 = never
}

export type OwnedGamesSort = "playtime" | "recent" | "backlog" | "name";

/** Games under this many minutes count as backlog: launched once to check it works, never really played. */
export const BACKLOG_MAX_MINUTES = 60;

/**
 * Pick and order which owned games to show. Returns at most `limit` games; never mutates `games`.
 *  - playtime: most-played first
 *  - recent:   most recently played first; never-played last
 *  - backlog:  only games under BACKLOG_MAX_MINUTES; never-launched first, then newer appids first
 *  - name:     alphabetical (falls back to appid when Steam omits the name)
 * Ties break on appid ascending so output is stable.
 */
export function rankOwnedGames(games: OwnedGame[], sort: OwnedGamesSort, limit: number): OwnedGame[] {
  const label = (g: OwnedGame) => g.name ?? String(g.appid);
  const compare: Record<OwnedGamesSort, (a: OwnedGame, b: OwnedGame) => number> = {
    playtime: (a, b) => b.playtime_forever - a.playtime_forever,
    recent: (a, b) => (b.rtime_last_played ?? 0) - (a.rtime_last_played ?? 0),
    backlog: (a, b) => Number(a.playtime_forever > 0) - Number(b.playtime_forever > 0) || b.appid - a.appid,
    name: (a, b) => label(a).localeCompare(label(b), "en", { sensitivity: "base" }),
  };
  const pool = sort === "backlog" ? games.filter((g) => g.playtime_forever < BACKLOG_MAX_MINUTES) : [...games];
  return pool.sort((a, b) => compare[sort](a, b) || a.appid - b.appid).slice(0, limit);
}

export function shapeOwnedGames(raw: any, sort: OwnedGamesSort, limit: number) {
  const r = raw?.response ?? {};
  const games: OwnedGame[] = r.games ?? [];
  if (!r.game_count && games.length === 0) {
    return { private_or_empty: true, note: "No games returned. The profile's game details are probably private." };
  }
  const picked = rankOwnedGames(games, sort, limit).map((g) => ({
    appid: g.appid,
    name: g.name,
    hours: +(g.playtime_forever / 60).toFixed(1),
    hours_2weeks: g.playtime_2weeks ? +(g.playtime_2weeks / 60).toFixed(1) : undefined,
    last_played: g.rtime_last_played ? new Date(g.rtime_last_played * 1000).toISOString().slice(0, 10) : undefined,
  }));
  const totalMinutes = games.reduce((s, g) => s + g.playtime_forever, 0);
  return {
    game_count: r.game_count ?? games.length,
    never_played: games.filter((g) => g.playtime_forever === 0).length,
    total_hours: Math.round(totalMinutes / 60),
    showing: picked.length,
    sort,
    games: picked,
  };
}

export function shapeAchievements(raw: any, onlyLocked: boolean) {
  const ps = raw?.playerstats;
  if (!ps?.success) return { error: ps?.error ?? "No achievement data (private profile or game has no achievements)." };
  const all: any[] = ps.achievements ?? [];
  const unlocked = all.filter((a) => a.achieved === 1).length;
  const list = (onlyLocked ? all.filter((a) => a.achieved !== 1) : all).map((a) => ({
    api_name: a.apiname,
    name: a.name,
    description: a.description,
    unlocked: a.achieved === 1,
    unlock_date: a.unlocktime ? new Date(a.unlocktime * 1000).toISOString().slice(0, 10) : undefined,
  }));
  return { game: ps.gameName, unlocked, total: all.length, achievements: list };
}

/** Pick the useful bits of a store appdetails entry (the raw one is huge and full of HTML). */
export function shapeAppDetails(raw: any, appid: number) {
  const entry = raw?.[appid];
  if (!entry?.success) return { error: `No store data for app ${appid} (unknown, removed or region-locked).` };
  const d = entry.data;
  return {
    appid,
    name: d.name,
    type: d.type,
    is_free: d.is_free,
    short_description: d.short_description,
    developers: d.developers,
    publishers: d.publishers,
    release_date: d.release_date?.date,
    coming_soon: d.release_date?.coming_soon,
    price: d.price_overview
      ? { final: d.price_overview.final_formatted, initial: d.price_overview.initial_formatted, discount_percent: d.price_overview.discount_percent }
      : undefined,
    platforms: d.platforms,
    metacritic: d.metacritic?.score,
    genres: d.genres?.map((g: any) => g.description),
    categories: d.categories?.map((c: any) => c.description),
    recommendations: d.recommendations?.total,
    achievements_total: d.achievements?.total,
    dlc_count: d.dlc?.length ?? 0,
    website: d.website,
    header_image: d.header_image,
  };
}

/** Strip HTML and cap length for news contents. */
export function stripHtml(s: string, max = 1500): string {
  const t = s.replace(/<[^>]+>/g, " ").replace(/\[\/?[a-z0-9*=_ ."':/-]+\]/gi, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
