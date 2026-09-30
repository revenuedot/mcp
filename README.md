# RevenueDot MCP

**Connect Claude, ChatGPT, Cursor and other AI assistants to RevenueDot, the open-source subscription backend that works with the RevenueCat SDK.**

The server has 17 tools to set up products, entitlements, offerings and packages, look up customers, grant or revoke access, add webhooks and follow an import from RevenueCat. Tool names match [RevenueCat's MCP tools](https://www.revenuecat.com/docs/tools/mcp/tools-reference) where the tool does the same thing, so prompts written for RevenueCat work here.

> Status: alpha. `@revenuedot/mcp` is not on npm yet and `mcp.revenuedot.app` is not deployed yet. Until then, run it from this repo (`pnpm install && pnpm build && node dist/cli.js`).

## Connect

**Hosted (Streamable HTTP):** `https://mcp.revenuedot.app/mcp`. Your client signs you in with OAuth, or you send `Authorization: Bearer sk_...`.

**Local (stdio), for RevenueDot Cloud or your own server:**

```bash
# Claude Code
claude mcp add revenuedot -e REVENUEDOT_API_KEY=sk_... -e REVENUEDOT_URL=https://your-server -- npx -y @revenuedot/mcp
```

```json
{
  "mcpServers": {
    "revenuedot": {
      "command": "npx",
      "args": ["-y", "@revenuedot/mcp"],
      "env": { "REVENUEDOT_API_KEY": "sk_...", "REVENUEDOT_URL": "https://your-server" }
    }
  }
}
```

Create the secret key under **API keys** in the RevenueDot dashboard. Give it only the permissions you want the assistant to have: a key with read scopes only cannot change anything, and a tool call that needs more gets an error naming the missing permission.

**Self-hosted HTTP:** `npx -y @revenuedot/mcp --http --port 8788 --url https://your-server` serves `http://127.0.0.1:8788/mcp`. Put it behind your reverse proxy with `--host 0.0.0.0 --public-url https://mcp.your-domain`. OAuth works against your own server too: it is the authorization server.

## Auth

1. **Secret key (bearer).** `Authorization: Bearer sk_...` is passed to the RevenueDot REST API v2, which checks the key's project and scopes.
2. **OAuth 2.1.** The RevenueDot server is the authorization server (`/.well-known/oauth-authorization-server`, dynamic client registration, authorization code with PKCE S256). The consent screen uses your dashboard session: you pick one project and read-only or read-and-write access. The access token is a secret key limited to that project and those scopes. It is listed under API keys as `OAuth: <client name>` and you revoke it there. This server publishes `/.well-known/oauth-protected-resource` and answers `401` with `WWW-Authenticate` so clients find the sign-in on their own.

## Tools

Every tool takes an optional `project_id`. Leave it out when the key or connection has one project.

| Tool | What it does | API v2 call |
|---|---|---|
| `list-projects` | Projects this key or connection can use | `GET /v2/projects` |
| `list-apps` | Apps, one per store | `GET /apps` |
| `list-products` | Products, optionally for one app | `GET /products` |
| `create-product` | Adds a store product to an app | `POST /products` |
| `list-entitlements` | Entitlements with their products | `GET /entitlements` |
| `create-entitlement` | Adds an entitlement such as `pro` | `POST /entitlements` |
| `attach-products-to-entitlement` | Makes products unlock an entitlement | `POST /entitlements/{id}/actions/attach_products` |
| `list-offerings` | Offerings with packages and products | `GET /offerings` |
| `create-offering` | Adds an offering, optionally current | `POST /offerings` |
| `create-packages` | Adds a package to an offering | `POST /offerings/{id}/packages` |
| `attach-products-to-package` | Puts products in a package | `POST /packages/{id}/actions/attach_products` |
| `get-customer` | Customer, active entitlements, attributes, subscriptions, purchases | `GET /customers/{id}` and sub-resources |
| `grant-customer-entitlement` | Promotional access until a date (creates the customer if new) | `POST /customers/{id}/actions/grant_entitlement` |
| `revoke-customer-entitlement` | Ends granted access | `POST /customers/{id}/actions/revoke_granted_entitlement` |
| `list-webhook-integrations` | Webhooks | `GET /integrations/webhooks` |
| `create-webhook-integration` | Adds a webhook | `POST /integrations/webhooks` |
| `get-import-status` | Customers, subscriptions and pending Google tokens after `npx revenuedot import` | `GET /import/status` |

Entitlements can be named by id or lookup key. `expires_at` takes milliseconds, an ISO date or a duration such as `30d`.

## Use the tools without MCP

The tool definitions and executors depend only on zod and a small API client, so an in-app agent can reuse them:

```ts
import { createClient } from "@revenuedot/mcp";
import { tools, runTool } from "@revenuedot/mcp/tools";

const client = createClient({ baseUrl: "https://api.revenuedot.app", apiKey: process.env.REVENUEDOT_API_KEY! });
await runTool(client, "grant-customer-entitlement", { customer_id: "user_42", entitlement_id: "pro", expires_at: "30d" });
```

## Develop

```bash
pnpm install
pnpm test        # starts a real RevenueDot server from ../revenuedot (or REVENUEDOT_REPO) on in-memory Postgres
pnpm typecheck
pnpm dev         # HTTP on :8788 against REVENUEDOT_URL
npx wrangler deploy   # Cloudflare Worker (wrangler.toml)
```

RevenueDot is not affiliated with RevenueCat, Inc.
