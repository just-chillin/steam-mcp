import { SteamError, steamGet } from "./steam";

const STEAMID64 = /^7656119\d{10}$/;
const PROFILES_URL = /steamcommunity\.com\/profiles\/(7656119\d{10})/i;
const VANITY_URL = /steamcommunity\.com\/id\/([^/?#]+)/i;

/**
 * Turn whatever the user typed into a SteamID64.
 * Accepts: 76561198000000000, https://steamcommunity.com/profiles/7656..., https://steamcommunity.com/id/name, or "name".
 */
export async function resolveSteamId(apiKey: string, input: string): Promise<string> {
  const s = input.trim();
  if (STEAMID64.test(s)) return s;

  const profile = s.match(PROFILES_URL);
  if (profile) return profile[1];

  const vanity = s.match(VANITY_URL)?.[1] ?? s;
  const data = await steamGet(apiKey, "ISteamUser", "ResolveVanityURL", 1, { vanityurl: vanity });
  if (data?.response?.success === 1) return data.response.steamid;
  throw new SteamError(`Could not resolve "${input}" to a Steam account (no matching custom URL).`);
}
