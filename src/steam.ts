// Thin HTTP client for the two Steam hosts we talk to.
// - api.steampowered.com: official Web API, needs the key.
// - store.steampowered.com: unofficial storefront JSON, keyless, rate-limited (~200 req / 5 min).

const API_BASE = "https://api.steampowered.com";
const STORE_BASE = "https://store.steampowered.com";
const TIMEOUT_MS = 10_000;
const STORE_CACHE_TTL = 3600;

export type Params = Record<string, string | number | boolean | undefined>;

export class SteamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function buildQuery(params: Params): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    q.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  return q;
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new SteamError(`Request to Steam failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new SteamError(
        "Steam refused the request (401/403). Usually the profile or game details are private, or the API key is invalid.",
        res.status,
      );
    }
    if (res.status === 429) throw new SteamError("Steam rate limit hit (429). Try again shortly.", 429);
    throw new SteamError(`Steam returned HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SteamError(`Steam returned non-JSON: ${text.slice(0, 200)}`, res.status);
  }
}

/** Call api.steampowered.com/{iface}/{method}/v{version}/ with the key injected. */
export async function steamGet(
  apiKey: string,
  iface: string,
  method: string,
  version: number,
  params: Params = {},
): Promise<any> {
  if (!apiKey) throw new SteamError("STEAM_API_KEY is not configured on the server.");
  const url = new URL(`${API_BASE}/${iface}/${method}/v${version}/`);
  url.search = buildQuery({ ...params, key: apiKey, format: "json" }).toString();
  return fetchJson(url);
}

/** Call store.steampowered.com/{path}, cached at the edge for an hour. */
export async function storeGet(path: string, params: Params = {}): Promise<any> {
  const url = new URL(`${STORE_BASE}/${path}`);
  url.search = buildQuery(params).toString();
  // `cf.cacheTtl` is honoured on Cloudflare and ignored elsewhere (tests, node).
  return fetchJson(url, { cf: { cacheTtl: STORE_CACHE_TTL, cacheEverything: true } } as RequestInit);
}
