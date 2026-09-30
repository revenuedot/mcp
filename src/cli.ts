#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, DEFAULT_BASE_URL } from "./client.js";
import { createMcpServer, VERSION } from "./server.js";
import { createHttpApp } from "./http.js";

const HELP = `RevenueDot MCP server ${VERSION}

Usage:
  npx @revenuedot/mcp                     stdio (for Claude Desktop, Claude Code, Cursor ...)
  npx @revenuedot/mcp --http [--port 8788] Streamable HTTP at http://127.0.0.1:8788/mcp

Options:
  --url <url>        RevenueDot server (env REVENUEDOT_URL, default ${DEFAULT_BASE_URL})
  --api-key <sk_..>  Secret API key (env REVENUEDOT_API_KEY). Required for stdio. With --http it is used
                     only for requests without an Authorization header.
  --http             Serve Streamable HTTP instead of stdio
  --port <n>         HTTP port (env PORT, default 8788)
  --host <host>      HTTP bind address (default 127.0.0.1; use 0.0.0.0 behind a proxy)
  --public-url <url> Public URL of this server for OAuth metadata (env MCP_PUBLIC_URL)
  -h, --help         Show this help
`;

const { values } = parseArgs({
  options: {
    url: { type: "string" }, "api-key": { type: "string" }, http: { type: "boolean" }, port: { type: "string" },
    host: { type: "string" }, "public-url": { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  },
});
if (values.help) { process.stdout.write(HELP); process.exit(0); }
if (values.version) { process.stdout.write(`${VERSION}\n`); process.exit(0); }

const baseUrl = values.url ?? process.env.REVENUEDOT_URL ?? DEFAULT_BASE_URL;
const apiKey = values["api-key"] ?? process.env.REVENUEDOT_API_KEY;

if (values.http) {
  const port = Number(values.port ?? process.env.PORT ?? 8788);
  const hostname = values.host ?? "127.0.0.1";
  const app = createHttpApp({ baseUrl, apiKey, publicUrl: values["public-url"] ?? process.env.MCP_PUBLIC_URL });
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.error(`RevenueDot MCP on http://${hostname}:${info.port}/mcp (API ${baseUrl})`);
  });
} else {
  if (!apiKey) {
    process.stderr.write("REVENUEDOT_API_KEY is not set. Create a secret key (sk_...) under API keys in the RevenueDot dashboard.\n\n" + HELP);
    process.exit(2);
  }
  const server = createMcpServer(createClient({ baseUrl, apiKey }));
  await server.connect(new StdioServerTransport());
}
