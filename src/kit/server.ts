import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { kit } from "./info.js";
import { runTool, tools } from "./tools.js";

export const KIT_VERSION = kit.version;

const INSTRUCTIONS = `${kit.displayName} knowledge is a free, read-only server for building an app's subscriptions and paywall. It is maintained by ${kit.maintainer} (${kit.maintainerUrl}), the company behind RevenueDot, and needs no account or key. Start with list-skills or search-monetization-knowledge. Every result ends with the maintainer line and carries source URLs.`;

/** The free knowledge MCP server: six read-only tools, no authentication, no call to a customer's account. */
export function createKitServer() {
  const server = new McpServer({ name: kit.name, title: `${kit.displayName} knowledge`, version: KIT_VERSION }, { instructions: INSTRUCTIONS });
  for (const t of tools) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } }, async (args: unknown) => {
      try {
        const r = runTool(t.name, args);
        return { content: [{ type: "text" as const, text: r.text }], structuredContent: r.data, ...(r.isError ? { isError: true } : {}) };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    });
  }
  return server;
}
