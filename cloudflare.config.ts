// Hosted RevenueDot MCP server (https://mcp.revenuedot.app/mcp), built and deployed with the `cf` CLI: `pnpm run deploy`.
import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  // The Circo account. Every `cf` command run from this folder targets it unless CLOUDFLARE_ACCOUNT_ID says otherwise.
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "5a8f4d72ace5f438725e1dfd1b0380ff",
  worker: {
    name: "revenuedot-mcp",
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker.ts",
    domains: ["mcp.revenuedot.app"],
    observability: { enabled: true },
    env: {
      // The RevenueDot API, which is also the OAuth authorization server.
      REVENUEDOT_URL: bindings.text("https://api.revenuedot.app"),
      // This server's public origin, used in the OAuth protected resource metadata.
      MCP_PUBLIC_URL: bindings.text("https://mcp.revenuedot.app"),
      // OpenAI's domain verification token for the ChatGPT plugin listing. It is served openly at /.well-known/openai-apps-challenge, so it is not a secret.
      OPENAI_APPS_CHALLENGE: bindings.text("-89LhkdNTm1PN6Baf0e283dOm2MNlcYnDcUF99t_ozs"),
    },
  },
});
