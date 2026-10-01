# RevenueDot MCP

**Connect Claude, ChatGPT, Cursor and other AI assistants to RevenueDot, the open-source subscription backend that works with the RevenueCat SDK.**

The server has 34 tools to set up products, entitlements, offerings and packages, find customers and read their history, grant, extend, cancel or refund, add and debug webhooks, check store credentials, read revenue metrics and follow an import from RevenueCat. It is also the server behind the RevenueDot ChatGPT plugin and Claude connector (install: [`revenuedot/agent-skills`](https://github.com/revenuedot/agent-skills)). Tool names match [RevenueCat's MCP tools](https://www.revenuecat.com/docs/tools/mcp/tools-reference) where the tool does the same thing, so prompts written for RevenueCat work here.

> Status (2026-09-30): the hosted server is live at `https://mcp.revenuedot.app/mcp`, in front of RevenueDot Cloud (`https://api.revenuedot.app`). The local server is published on npm as [`@revenuedot/mcp`](https://www.npmjs.com/package/@revenuedot/mcp), so `npx -y @revenuedot/mcp` runs the latest release.

## Connect

**Hosted (Streamable HTTP):** `https://mcp.revenuedot.app/mcp`. Your client signs you in with OAuth, or you send `Authorization: Bearer sk_...`.

**Local (stdio), for RevenueDot Cloud or your own server** (`REVENUEDOT_URL` defaults to `https://api.revenuedot.app`):

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
| `get-project-health` | Per app: do the store credentials work, do notifications arrive; are webhooks delivered | `GET /setup_health` |
| `get-metrics` | Overview cards, or one metric's daily history | `GET /metrics/overview`, `/metrics/history` |
| `list-customers` | Newest first, or search by app user id, email or transaction id | `GET /customers` |
| `list-transactions` | Purchases, renewals, trials and refunds | `GET /transactions` |
| `list-events` | The event log (the events webhooks send), by customer, type or environment | `GET /events` |
| `set-customer-attributes` | Sets or deletes attributes (destructive: it overwrites) | `POST /customers/{id}/attributes` |
| `delete-customer` | Deletes a customer's data (destructive) | `DELETE /customers/{id}` |
| `extend-subscription` | Free days, or until a date | `POST /subscriptions/{id}/actions/extend` |
| `cancel-subscription` | Cancels at period end (destructive) | `POST /subscriptions/{id}/actions/cancel` |
| `refund-subscription` | Refunds and ends access (destructive) | `POST /subscriptions/{id}/actions/refund` |
| `create-test-purchase` | Simulates a Test Store purchase lifecycle | `POST /test_purchases` |
| `archive-offering` | Hides an offering (destructive) | `POST /offerings/{id}/actions/archive` |
| `list-webhook-deliveries` | Delivery attempts, by status | `GET /webhooks/{id}/deliveries` |
| `retry-webhook-delivery` | Sends a delivery again | `POST /webhooks/{id}/deliveries/{id}/retry` |
| `send-test-webhook` | Sends a TEST event | `POST /integrations/webhooks/{id}/test` |
| `delete-webhook-integration` | Deletes a webhook (destructive) | `DELETE /integrations/webhooks/{id}` |
| `verify-store-credentials` | Calls Apple or Google with the saved key and reports whether it works | `POST /apps/{id}/actions/verify_credentials` |

No tool accepts a key, password or credential: store keys and webhook headers are entered in the dashboard. Creating a webhook returns its signing secret once.

### OAuth scopes

| Scope | Lets the assistant | Tools |
|---|---|---|
| `project:read` | Read everything | the 15 read-only tools |
| `project:write` | Change the catalog, grant and revoke access, manage webhooks, delete customers | 15 tools (10 writes, 5 destructive) |
| `project:support` | Cancel, refund and extend subscriptions, make Test Store purchases. Asked for separately, only when a tool needs it | `extend-subscription`, `cancel-subscription`, `refund-subscription`, `create-test-purchase` |

A tool that needs more than the connection has returns an error with `_meta["mcp/www_authenticate"]`, which ChatGPT and Claude use to ask you for the missing access. Every tool descriptor also carries `_meta.securitySchemes`.

`scripts/verify-live.mjs` checks a deployed server against the directories' rules (`REVENUEDOT_MCP_TOKEN=sk_... node scripts/verify-live.mjs`).

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
pnpm run deploy  # Cloudflare Worker with the cf CLI (cloudflare.config.ts, Circo account); needs Node 22.18+
```

Use Node 24. CI (`.github/workflows/ci.yml`) runs typecheck, build and tests on every push and pull request. On `main` it then deploys `mcp.revenuedot.app` with the `production` environment's secrets and checks it live with `scripts/verify-live.mjs`: the protected resource metadata answers and `POST /mcp` without a token answers 401. Pushing to `main` is a production deploy.

RevenueDot is not affiliated with RevenueCat, Inc.
