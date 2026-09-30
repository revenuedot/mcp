import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createClient, DEFAULT_BASE_URL } from "./client.js";
import { createMcpServer, VERSION } from "./server.js";

export interface HttpOptions {
  /** RevenueDot server; also the OAuth authorization server. */
  baseUrl?: string;
  /** This MCP server's public URL (without /mcp). Defaults to the request origin. */
  publicUrl?: string;
  /** A key used when a request has no Authorization header. Only for a local, single-user server. */
  apiKey?: string;
  fetch?: typeof fetch;
}

const SCOPES = ["project:read", "project:write"];
const VALID_FOR_MS = 60_000;

/**
 * Streamable HTTP endpoint at /mcp (stateless: a fresh server per request, JSON responses) plus OAuth protected resource
 * metadata (RFC 9728). Clients send `Authorization: Bearer <token>`, where the token is a secret key (sk_...) or an OAuth
 * access token from the RevenueDot server, which is also a project-scoped secret key. Runs on Node and Cloudflare Workers.
 */
export function createHttpApp(opts: HttpOptions = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const origin = (c: Context) => (opts.publicUrl?.replace(/\/+$/, "")) || (() => {
    const host = c.req.header("x-forwarded-host");
    return host ? `${c.req.header("x-forwarded-proto") ?? "https"}://${host}` : new URL(c.req.url).origin;
  })();
  const prmUrl = (c: Context) => `${origin(c)}/.well-known/oauth-protected-resource/mcp`;
  // Tokens the API recently accepted (per process or Worker isolate), so each MCP message costs one API call, not two.
  const valid = new Map<string, number>();

  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["*"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], exposeHeaders: ["mcp-session-id", "mcp-protocol-version", "www-authenticate"] }));

  const metadata = (c: Context) => c.json({
    resource: `${origin(c)}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "RevenueDot",
    resource_documentation: "https://revenuedot.app/docs/mcp",
  });
  app.get("/.well-known/oauth-protected-resource", metadata);
  app.get("/.well-known/oauth-protected-resource/mcp", metadata);
  app.get("/", (c) => c.json({ name: "RevenueDot MCP", version: VERSION, mcp: `${origin(c)}/mcp`, api: baseUrl }));
  app.get("/health", (c) => c.json({ status: "ok" }));

  const unauthorized = (c: Context, error?: string, description?: string) => {
    const parts = [`resource_metadata="${prmUrl(c)}"`, `scope="${SCOPES.join(" ")}"`];
    if (error) parts.unshift(`error="${error}"`, `error_description="${description}"`);
    c.header("WWW-Authenticate", `Bearer ${parts.join(", ")}`);
    return c.json({ jsonrpc: "2.0", error: { code: -32001, message: description ?? "Authorization required. Connect with OAuth or send Authorization: Bearer sk_..." }, id: null }, 401);
  };

  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization");
    const token = header?.replace(/^Bearer\s+/i, "").trim() || opts.apiKey;
    if (!token) return unauthorized(c);
    if (!token.startsWith("sk_")) return unauthorized(c, "invalid_token", "Use a RevenueDot secret API key (sk_...) or connect with OAuth.");
    const now = Date.now();
    if ((valid.get(token) ?? 0) < now) {
      // 401 means revoked or unknown; 403 still means a real key (just without projects:read).
      const res = await doFetch(`${baseUrl}/v2/projects?limit=1`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      if (!res) return c.json({ jsonrpc: "2.0", error: { code: -32603, message: `Could not reach the RevenueDot server at ${baseUrl}.` }, id: null }, 502);
      if (res.status === 401) return unauthorized(c, "invalid_token", "The token is invalid or was revoked.");
      if (valid.size > 1000) valid.clear();
      valid.set(token, now + VALID_FOR_MS);
    }
    const server = createMcpServer(createClient({ baseUrl, apiKey: token, fetch: doFetch }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
