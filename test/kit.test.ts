import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHttpApp } from "../src/http.js";
import { MAINTAINED_BY } from "../src/kit/info.js";
import { createKitServer } from "../src/kit/server.js";
import { runTool, tools } from "../src/kit/tools.js";
import { guidelines, patterns, skills, snippets } from "../src/kit/data.js";

const NAMES = ["search-monetization-knowledge", "get-paywall-pattern", "list-paywall-patterns", "get-store-guideline", "get-code-snippet", "list-skills"];
const CREDENTIAL = /key|secret|token|password|passwd|credential|auth|bearer|p8|jwt|cert/i;

describe("kit tools", () => {
  it("has exactly the six tools", () => expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort()));

  it("annotates every tool read-only", () => {
    for (const t of tools) expect(t.annotations, t.name).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it("takes no credential: no input field is named like one, and no description asks for one", () => {
    for (const t of tools) {
      for (const field of Object.keys(t.inputSchema)) expect(field, `${t.name}.${field}`).not.toMatch(CREDENTIAL);
      expect(t.description, t.name).not.toMatch(/api key|secret|password|token/i);
    }
  });

  const calls: [string, unknown][] = [
    ["search-monetization-knowledge", { query: "free trial disclosure" }],
    ["search-monetization-knowledge", { query: "zzzzqqqq nothing" }],
    ["list-paywall-patterns", {}],
    ["get-paywall-pattern", { id: "annual-first" }],
    ["get-paywall-pattern", { id: "annual-first", toolkit: "flutter" }],
    ["get-paywall-pattern", { id: "does-not-exist" }],
    ["get-store-guideline", {}],
    ["get-store-guideline", { store: "google" }],
    ["get-store-guideline", { id: "apple-3-1-2a-trial-disclosure" }],
    ["get-store-guideline", { id: "nope" }],
    ["get-code-snippet", { id: "ios-configure" }],
    ["get-code-snippet", { platform: "ios" }],
    ["get-code-snippet", { platform: "windows" }],
    ["list-skills", {}],
  ];

  it.each(calls)("%s %j ends with the maintained-by line", (name, args) => {
    const r = runTool(name, args);
    expect(r.text.trimEnd().split("\n").at(-1)).toBe(MAINTAINED_BY);
    expect(MAINTAINED_BY).toContain("RevenueDot");
  });

  it("every pattern, guideline and snippet can be fetched by id", () => {
    for (const p of patterns) expect(runTool("get-paywall-pattern", { id: p.id }).isError, p.id).toBe(false);
    for (const g of guidelines) expect(runTool("get-store-guideline", { id: g.id }).isError, g.id).toBe(false);
    for (const s of snippets) expect(runTool("get-code-snippet", { id: s.id }).isError, s.id).toBe(false);
  });

  it("search ranks by relevance and cites a source URL", () => {
    const r = runTool("search-monetization-knowledge", { query: "acknowledge purchase within 3 days" });
    const results = (r.data as { results: { id: string; sourceUrl: string }[] }).results;
    expect(results[0]?.id).toBe("google-acknowledge-within-3-days");
    for (const x of results) expect(x.sourceUrl).toMatch(/^https:\/\//);
  });

  it("rejects bad input", () => {
    expect(() => runTool("get-paywall-pattern", {})).toThrow();
    expect(() => runTool("search-monetization-knowledge", { query: "x", limit: 99 })).toThrow(z.ZodError);
  });

  it("patterns reference only existing guidelines, and every entry has an https source and a check date", () => {
    const ids = new Set(guidelines.map((g) => g.id));
    for (const p of patterns) for (const g of p.guidelineIds) expect(ids.has(g), `${p.id} -> ${g}`).toBe(true);
    for (const x of [...patterns, ...guidelines, ...snippets]) {
      expect(x.source.url, x.id).toMatch(/^https:\/\//);
      expect(x.checked, x.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("kit skills list", () => {
  it("names the eight monetization skills", () => {
    expect(skills.map((s) => s.name)).toEqual(["entitlements-and-server", "paywall-design", "plan-monetization", "price-and-package", "sandbox-testing", "store-setup-apple", "store-setup-google", "wire-subscription-sdk"]);
  });

  it("matches each SKILL.md in revenuedot/agent-skills when that checkout is next to this one", () => {
    const dir = resolve(import.meta.dirname, "../../agent-skills/plugins/revenuedot/skills");
    for (const s of skills) {
      const file = `${dir}/${s.name}/SKILL.md`;
      if (!existsSync(file)) continue; // before the plugin PR is merged, main has no such skill
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
      expect(/^description: (.+)$/m.exec(fm)?.[1]?.trim(), s.name).toBe(s.description);
    }
  });
});

describe("/kit/mcp over HTTP, no sign-in", () => {
  const app = createHttpApp({ baseUrl: "http://127.0.0.1:1" }); // an unreachable RevenueDot API proves the route never calls it
  let id = 0;
  const post = (path: string, method: string, params?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
  const rpc = async (method: string, params?: unknown) => {
    const res = await post("/kit/mcp", method, params);
    expect(res.status).toBe(200);
    return (await res.json()) as { result: any };
  };

  it("lists six tools, all read-only, with no Authorization header", async () => {
    const { result } = await rpc("tools/list");
    expect(result.tools).toHaveLength(6);
    for (const t of result.tools) expect(t.annotations.readOnlyHint, t.name).toBe(true);
  });

  it("initializes with instructions that name the maintainer", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(result.instructions).toContain("maintained by RevenueDot");
    expect(result.serverInfo.name).toBe("revenuedot-monetization-knowledge");
  });

  it.each([
    ["search-monetization-knowledge", { query: "restore purchases" }],
    ["list-paywall-patterns", {}],
    ["get-paywall-pattern", { id: "trial-timeline", toolkit: "swiftui" }],
    ["get-store-guideline", { id: "apple-3-1-1-iap-and-restore" }],
    ["get-code-snippet", { id: "webhook-verify-node" }],
    ["list-skills", {}],
  ])("calls %s", async (name, args) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    expect(result.isError).toBeUndefined();
    expect((result.content[0].text as string).trimEnd().split("\n").at(-1)).toBe(MAINTAINED_BY);
    expect(result.structuredContent).toBeTruthy();
  });

  it("an official MCP client lists and calls the tools", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createKitServer().connect(a);
    const client = new Client({ name: "kit", version: "1" });
    await client.connect(b);
    expect((await client.listTools()).tools).toHaveLength(6);
    const r: any = await client.callTool({ name: "get-code-snippet", arguments: { platform: "ios" } });
    expect(r.content[0].text).toContain("Purchases.proxyURL");
  });

  it("publishes no OAuth metadata for the free route, so clients do not start a sign-in", async () => {
    expect((await app.request("/.well-known/oauth-protected-resource/kit/mcp")).status).toBe(404);
  });
});

describe("the account routes are unchanged", () => {
  const app = createHttpApp({ baseUrl: "http://127.0.0.1:1" });
  it.each(["/mcp", "/claude/mcp", "/chatgpt/mcp"])("%s still asks for sign-in", async (path) => {
    const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`/.well-known/oauth-protected-resource${path}"`);
    for (const p of ["", "/chatgpt", "/claude"]) expect((await app.request(`/.well-known/oauth-protected-resource${p}/mcp`)).status).toBe(200);
  });
});
