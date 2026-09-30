import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createHttpApp } from "../src/http.js";
import { listen, startRevenueDot, type RevenueDot } from "./revenuedot.js";

/** End to end: the official MCP SDK client talks to our MCP server over Streamable HTTP (bearer key and OAuth) and stdio. */

let rd: RevenueDot;
let mcpUrl: string;
let closeMcp: () => void;

beforeAll(async () => {
  rd = await startRevenueDot();
  // Pick the port first so the protected resource metadata names the real URL.
  let publicUrl = "";
  const app = { fetch: (r: Request) => createHttpApp({ baseUrl: rd.url, publicUrl }).fetch(r) };
  const { url, server } = await listen(app.fetch);
  publicUrl = url;
  mcpUrl = `${url}/mcp`;
  closeMcp = () => server.close();
});
afterAll(async () => { closeMcp?.(); await rd?.close(); });

const text = (r: any) => JSON.parse(r.content[0].text);

async function connect(headers: Record<string, string>) {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }));
  return client;
}

describe("Streamable HTTP with a secret key", () => {
  it("lists 17 tools with schemas and annotations, and runs a setup through them", async () => {
    const client = await connect({ Authorization: `Bearer ${rd.key}` });
    expect(client.getServerVersion()).toMatchObject({ name: "revenuedot" });
    expect(client.getInstructions()).toContain("RevenueDot");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
    const grant = tools.find((t) => t.name === "grant-customer-entitlement")!;
    expect(grant.inputSchema.required).toEqual(expect.arrayContaining(["customer_id", "entitlement_id", "expires_at"]));
    expect(grant.annotations).toMatchObject({ readOnlyHint: false, title: "Grant entitlement to customer" });
    expect(tools.find((t) => t.name === "list-offerings")!.annotations).toMatchObject({ readOnlyHint: true });

    const product = text(await client.callTool({ name: "create-product", arguments: { app_id: rd.apps.test, store_identifier: "e2e_monthly", type: "subscription", subscription_duration: "P1M" } }));
    const ent = text(await client.callTool({ name: "create-entitlement", arguments: { lookup_key: "e2e", display_name: "E2E" } }));
    await client.callTool({ name: "attach-products-to-entitlement", arguments: { entitlement_id: ent.id, product_ids: [product.id] } });
    const granted = text(await client.callTool({ name: "grant-customer-entitlement", arguments: { customer_id: "mcp_user", entitlement_id: "e2e", expires_at: "7d" } }));
    expect(granted.active_entitlements.items[0].entitlement_id).toBe(ent.id);
    const status = text(await client.callTool({ name: "get-import-status", arguments: {} }));
    expect(status.customers).toBeGreaterThanOrEqual(1);
    await client.close();
  });

  it("tool errors come back as isError with the API's message; invalid arguments are rejected", async () => {
    const client = await connect({ Authorization: `Bearer ${rd.readOnlyKey}` });
    const r = await client.callTool({ name: "create-entitlement", arguments: { lookup_key: "x", display_name: "X" } }) as any;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("403 authorization_error");
    expect(r.content[0].text).toContain("project_configuration:entitlements:read_write");
    const bad = await client.callTool({ name: "create-product", arguments: { type: "nope" } }) as any;
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("answers 401 with WWW-Authenticate pointing at the protected resource metadata when there is no or a bad token", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    const post = (headers: Record<string, string>) => fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
    const none = await post({});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain(`resource_metadata="${mcpUrl.replace("/mcp", "")}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await post({ authorization: "Bearer sk_revoked" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const prm = await (await fetch(`${mcpUrl.replace("/mcp", "")}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toEqual(expect.objectContaining({ resource: mcpUrl, authorization_servers: [rd.url], scopes_supported: ["project:read", "project:write"] }));
  });
});

/** An in-memory MCP OAuth client whose "browser" signs in to the RevenueDot dashboard session and approves the consent screen. */
class TestOAuthProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  constructor(private approve: (url: URL) => Promise<string>) {}
  get redirectUrl() { return "http://localhost:39999/callback"; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "E2E Client", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "project:write" };
  }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationMixed) { this.info = i; }
  tokens() { return this.saved; }
  saveTokens(t: OAuthTokens) { this.saved = t; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  code?: string;
  async redirectToAuthorization(url: URL) { this.authorizationUrl = url; this.code = await this.approve(url); }
}

describe("OAuth: discovery, dynamic registration, consent with the dashboard session, PKCE, then tools on one project", () => {
  it("connects Claude-style: 401 -> metadata -> register -> authorize -> token -> tools limited to the chosen project", async () => {
    const other = await rd.signup("second@example.com", "Second app");
    // The user is signed in to the dashboard as the owner; they pick the owner's project and approve.
    const approve = async (url: URL) => {
      const page = await fetch(url, { headers: { cookie: rd.cookie } });
      const html = await page.text();
      expect(html).toContain("Connect E2E Client to RevenueDot");
      const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
      const res = await fetch(new URL("/oauth/authorize", url), {
        method: "POST", redirect: "manual", headers: { cookie: rd.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...fields, project_id: rd.projectId, access: "project:write", decision: "allow" }),
      });
      expect(res.status).toBe(302);
      const back = new URL(res.headers.get("location")!);
      expect(back.searchParams.get("state")).toBe(url.searchParams.get("state"));
      return back.searchParams.get("code")!;
    };
    const provider = new TestOAuthProvider(approve);
    const client = new Client({ name: "oauth-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);

    const authUrl = provider.authorizationUrl!;
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(`${rd.url}/oauth/authorize`);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("resource")).toBe(mcpUrl);
    expect(provider.info?.client_id).toMatch(/^oac_/);

    await transport.finishAuth(provider.code!);
    expect(provider.saved?.access_token).toMatch(/^sk_/);

    const connected = new Client({ name: "oauth-e2e", version: "1.0.0" });
    await connected.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider }));
    expect((await connected.listTools()).tools).toHaveLength(17);
    const projects = text(await connected.callTool({ name: "list-projects", arguments: {} }));
    expect(projects.items.map((p: any) => p.id)).toEqual([rd.projectId]);
    const denied = await connected.callTool({ name: "list-apps", arguments: { project_id: other.projectId } }) as any;
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("404");
    const ent = text(await connected.callTool({ name: "create-entitlement", arguments: { lookup_key: "oauth", display_name: "Via OAuth" } }));
    expect(ent.lookup_key).toBe("oauth");
    await connected.close();

    // Revoking the key in the dashboard ends the connection: the MCP server answers 401 invalid_token again.
    const keys = await (await fetch(`${rd.url}/v2/projects/${rd.projectId}/api_keys`, { headers: { cookie: rd.cookie } })).json() as any;
    const k = keys.items.find((x: any) => x.name === "OAuth: E2E Client");
    expect(k.permissions).toContain("project_configuration:entitlements:read_write");
    await fetch(`${rd.url}/v2/projects/${rd.projectId}/api_keys/${k.id}`, { method: "DELETE", headers: { cookie: rd.cookie } });
    // A fresh MCP server instance (no validation cache) must reject it.
    const fresh = createHttpApp({ baseUrl: rd.url, publicUrl: mcpUrl.replace("/mcp", "") });
    const res = await fresh.fetch(new Request(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${provider.saved!.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }));
    expect(res.status).toBe(401);
  });
});

describe("stdio (npx @revenuedot/mcp)", () => {
  it("starts from the CLI with REVENUEDOT_URL and REVENUEDOT_API_KEY and serves the same tools", async () => {
    const root = resolve(import.meta.dirname, "..");
    const transport = new StdioClientTransport({
      command: process.execPath, args: [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "src/cli.ts")],
      env: { ...process.env as Record<string, string>, REVENUEDOT_URL: rd.url, REVENUEDOT_API_KEY: rd.key }, stderr: "pipe",
    });
    const client = new Client({ name: "stdio-e2e", version: "1.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(17);
    const apps = text(await client.callTool({ name: "list-apps", arguments: {} }));
    expect(apps.items).toHaveLength(2);
    await client.close();
  });
});
