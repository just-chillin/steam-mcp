# steam-mcp

A remote [MCP](https://modelcontextprotocol.io) server for the Steam Web API, running on Cloudflare Workers. Point Claude (or any MCP client) at `https://<your-worker>/mcp` and ask about players, libraries, achievements, prices and news.

Stateless Streamable HTTP, no Durable Objects, no database. One Worker, one secret.

## Tools

| Tool | What it does |
|---|---|
| `resolve_vanity_url` | custom URL / name → SteamID64 |
| `get_player_summaries` | profile, online state, current game (≤100 players) |
| `get_friend_list` | friends + since-date |
| `get_player_bans` | VAC / game / trade bans |
| `get_owned_games` | library with playtime, sorted + trimmed |
| `get_recently_played_games` | last two weeks |
| `get_steam_level` | Steam level |
| `get_player_achievements` | per-game achievements with unlock dates |
| `search_store` | name → appid + price |
| `get_app_details` | store page: price, genres, release, devs, metacritic |
| `get_current_players` | live player count |
| `get_global_achievement_percentages` | how rare each achievement is |
| `get_game_schema` | achievement / stat definitions |
| `get_app_news` | news + patch notes (HTML stripped) |
| `get_app_list` | paged list of every app |
| `call_steam_api` | any GET on `api.steampowered.com` — escape hatch |

Every `player` argument accepts a SteamID64, a `steamcommunity.com/profiles/...` or `/id/...` URL, or a bare custom-URL name.

Responses are trimmed for LLM consumption (an owned-games call on a 3000-game library won't blow up the context). Use `call_steam_api` when you need the raw thing.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put STEAM_API_KEY      # from https://steamcommunity.com/dev/apikey
npx wrangler deploy
```

Or push to `main` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set as repo secrets — `.github/workflows/deploy.yml` tests and deploys.

## Auth

The Worker does **no** OAuth itself; put it behind a gateway (Cloudflare's MCP gateway / Access) that handles Claude connector auth.

Two ways to stop people bypassing the gateway via the public `*.workers.dev` URL:

1. **Shared header.** `npx wrangler secret put GATEWAY_SECRET` and have the gateway add `x-gateway-secret: <value>` to upstream requests. Without a match the Worker answers 401. Unset → open.
2. **No public hostname.** Set `"workers_dev": false` in `wrangler.jsonc` and expose the Worker only on a route the gateway controls.

## Local dev

```bash
cp .dev.vars.example .dev.vars   # add your key
npm run dev                      # http://localhost:8787/mcp
npm test
```

Quick check:

```bash
curl -s localhost:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_store","arguments":{"term":"hades"}}}'
```

## Notes

- Steam Web API docs: https://developer.valvesoftware.com/wiki/Steam_Web_API and https://partner.steamgames.com/doc/webapi
- `search_store` and `get_app_details` use the undocumented storefront JSON (`store.steampowered.com/api/*`). It's keyless, rate-limited (~200 req / 5 min), and cached at the edge for an hour here.
- Private profiles come back as a clear message, not a stack trace.
- The API key is injected server-side and never appears in tool output.
