import { createHttpApp } from "./http.js";

export interface Env { REVENUEDOT_URL?: string; MCP_PUBLIC_URL?: string; OPENAI_APPS_CHALLENGE?: string }

let app: ReturnType<typeof createHttpApp> | undefined;

/** Cloudflare Worker entry: the hosted MCP server (https://mcp.revenuedot.app/mcp). */
export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    app ??= createHttpApp({ baseUrl: env.REVENUEDOT_URL, publicUrl: env.MCP_PUBLIC_URL, openaiAppsChallenge: env.OPENAI_APPS_CHALLENGE });
    return app.fetch(request);
  },
};
