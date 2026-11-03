import { createMcpHandler } from "agents/mcp/server";
import { buildServer, type Env } from "./server";

/** Constant-time string compare so the gateway secret can't be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("steam-mcp: MCP endpoint at /mcp\n", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    // Optional: only accept traffic that came through your gateway.
    // The gateway sends `x-gateway-secret`; direct hits on *.workers.dev get 401.
    if (env.GATEWAY_SECRET) {
      const got = request.headers.get("x-gateway-secret") ?? "";
      if (!safeEqual(got, env.GATEWAY_SECRET)) return new Response("Unauthorized", { status: 401 });
    }

    return createMcpHandler(() => buildServer(env), { route: "/mcp" })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
