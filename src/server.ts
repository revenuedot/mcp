import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RevenueDotApiError, type RevenueDotClient } from "./client.js";
import { tools } from "./tools.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `RevenueDot is an open-source backend for in-app purchases that works with the RevenueCat SDK and API.
Setup order: list-apps, then create-product per app, create-entitlement, attach-products-to-entitlement, create-offering, create-packages, attach-products-to-package.
Every tool takes an optional project_id; leave it out when the connection has one project.`;

/** Formats an API failure so the model sees what went wrong (for a 403, the missing permission). */
export function errorText(e: unknown) {
  if (e instanceof RevenueDotApiError) return `RevenueDot API error (${e.status} ${e.type}): ${e.message}${e.param ? ` [param: ${e.param}]` : ""}`;
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}

/** An MCP server exposing the shared RevenueDot tools, each executed with the given API client. */
export function createMcpServer(client: RevenueDotClient) {
  const server = new McpServer({ name: "revenuedot", title: "RevenueDot", version: VERSION }, { instructions: INSTRUCTIONS });
  for (const t of tools) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } }, async (args: unknown) => {
      try {
        const result = await t.run(client, args as never);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: errorText(e) }] };
      }
    });
  }
  return server;
}
