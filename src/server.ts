import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RevenueDotApiError, type RevenueDotClient } from "./client.js";
import { oauthScopesFor, tools } from "./tools.js";

export const VERSION = "0.2.0";

const INSTRUCTIONS = `RevenueDot is an open-source backend for in-app purchases that works with the RevenueCat SDK and API.
Setup order: list-apps, then create-product per app, create-entitlement, attach-products-to-entitlement, create-offering, create-packages, attach-products-to-package.
Support: list-customers (by app user id, email or transaction id), get-customer, list-events, then grant-customer-entitlement or extend-subscription. Refunds and cancellations move money: ask the user first.
Health: get-project-health, get-metrics, list-webhook-deliveries.
Every tool takes an optional project_id; leave it out when the connection has one project. Results are JSON; lists carry items and next_page (pass its id as starting_after).`;

/** Formats an API failure so the model sees what went wrong (for a 403, the missing permission). */
export function errorText(e: unknown) {
  if (e instanceof RevenueDotApiError) return `RevenueDot API error (${e.status} ${e.type}): ${e.message}${e.param ? ` [param: ${e.param}]` : ""}`;
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}

export interface McpServerOptions {
  /** RFC 9728 metadata URL, sent with an insufficient-scope result so the client can ask the user for the missing scope. */
  resourceMetadataUrl?: string;
}

/** An MCP server exposing the shared RevenueDot tools, each executed with the given API client. */
export function createMcpServer(client: RevenueDotClient, opts: McpServerOptions = {}) {
  const server = new McpServer({ name: "revenuedot", title: "RevenueDot", version: VERSION }, { instructions: INSTRUCTIONS });
  for (const t of tools) {
    const oauth = oauthScopesFor(t.scopes);
    server.registerTool(t.name, {
      title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: oauth }] },
    }, async (args: unknown) => {
      try {
        const result = await t.run(client, args as never);
        const structured = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: structured };
      } catch (e) {
        const missing = e instanceof RevenueDotApiError && e.status === 403;
        return {
          isError: true, content: [{ type: "text" as const, text: errorText(e) }],
          // Both ChatGPT and Claude read this and re-run consent for the scope this tool needs.
          ...(missing && opts.resourceMetadataUrl ? { _meta: { "mcp/www_authenticate": [`Bearer error="insufficient_scope", error_description="${t.title} needs more access", scope="${oauth.join(" ")}", resource_metadata="${opts.resourceMetadataUrl}"`] } } : {}),
        };
      }
    });
  }
  return server;
}
