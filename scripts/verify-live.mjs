#!/usr/bin/env node
// Checks a deployed MCP server the way the ChatGPT and Claude directories will: unauthenticated discovery, then (with a token) the tool list.
//
//   node scripts/verify-live.mjs [https://mcp.revenuedot.app] [--count 34]
//   REVENUEDOT_MCP_TOKEN=sk_... node scripts/verify-live.mjs   # also lists tools with that token and runs the listing checks
import { checkListing } from "./listing-checks.mjs";

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? "https://mcp.revenuedot.app").replace(/\/+$/, "");
const count = Number(args[args.indexOf("--count") + 1] || 34);
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) fails.push(msg); };

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify-live", version: "1" } } };
const post = (body, headers = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

const none = await post(init);
const challenge = none.headers.get("www-authenticate") ?? "";
ok(none.status === 401, "POST /mcp without a token answers 401");
ok(/resource_metadata="https:\/\/[^"]+oauth-protected-resource/.test(challenge), "401 names the protected resource metadata");

const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
ok(prm.resource === `${base}/mcp`, "protected resource metadata names this server");
ok(prm.scopes_supported?.includes("project:support"), "scopes include project:support");
const issuer = prm.authorization_servers?.[0];
ok(!!issuer, `authorization server is ${issuer}`);

const meta = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
ok(meta.code_challenge_methods_supported?.includes("S256"), "PKCE S256 supported");
ok(meta.client_id_metadata_document_supported === true, "client ID metadata documents supported");
ok(meta.authorization_response_iss_parameter_supported === true, "iss parameter supported");
ok(!!meta.registration_endpoint, "dynamic client registration available");
ok(meta.token_endpoint_auth_methods_supported?.includes("none"), "public clients supported");

const cors = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://chatgpt.com", "access-control-request-method": "POST" } });
ok(cors.headers.get("access-control-allow-origin") === "*" || cors.headers.get("access-control-allow-origin") === "https://chatgpt.com", "CORS allows browser clients");

const token = process.env.REVENUEDOT_MCP_TOKEN;
if (token) {
  const auth = { authorization: `Bearer ${token}` };
  const sessionInit = await post(init, auth);
  ok(sessionInit.ok, "initialize with the token succeeds");
  const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, auth)).json();
  const problems = checkListing(list.result?.tools ?? [], { count });
  for (const p of problems) console.log(`FAIL ${p}`);
  ok(problems.length === 0, `${list.result?.tools?.length} tools pass the directory checks`);
  if (problems.length) fails.push(...problems);
} else console.log("skip tool list (set REVENUEDOT_MCP_TOKEN to check it)");

if (fails.length) { console.error(`\n${fails.length} problem(s)`); process.exit(1); }
console.log("\nall checks passed");
