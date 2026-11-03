import { describe, expect, it } from "vitest";
import worker from "../src/index";

const env = { STEAM_API_KEY: "k", GATEWAY_SECRET: "s3cret" };
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
// Cloudflare always sets Host; Node's Request doesn't, and the MCP handler validates it.
const HOST = "steam-mcp.example.workers.dev";
const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://${HOST}${path}`, { ...init, headers: { host: HOST, ...(init.headers as Record<string, string>) } });

describe("worker routing", () => {
  it("serves a health line at /", async () => {
    const res = await worker.fetch(req("/"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/mcp");
  });

  it("404s unknown paths", async () => {
    expect((await worker.fetch(req("/nope"), env, ctx)).status).toBe(404);
  });

  it("rejects /mcp without the gateway secret when one is configured", async () => {
    expect((await worker.fetch(req("/mcp", { method: "POST" }), env, ctx)).status).toBe(401);
    expect((await worker.fetch(req("/mcp", { method: "POST", headers: { "x-gateway-secret": "wrong" } }), env, ctx)).status).toBe(401);
  });

  it("lists tools over MCP when the secret matches", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const res = await worker.fetch(
      req("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-gateway-secret": "s3cret" },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const t of ["get_owned_games", "search_store", "call_steam_api"]) expect(text).toContain(t);
  });

  it("is open when no gateway secret is set", async () => {
    const res = await worker.fetch(req("/mcp", { method: "GET" }), { STEAM_API_KEY: "k" }, ctx);
    expect(res.status).not.toBe(401);
  });
});
