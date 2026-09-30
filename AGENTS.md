# AGENTS.md

MCP server for RevenueDot (`@revenuedot/mcp`). Layout:
- `src/tools.ts`: tool definitions and executors. They depend only on zod and `src/client.ts`, never on MCP, so the Tier 2 in-app agent in `revenuedot/revenuedot` imports them from `@revenuedot/mcp/tools`. Add a tool here once and both surfaces get it.
- `src/server.ts` registers the tools on an MCP server; `src/http.ts` is the Streamable HTTP endpoint and OAuth protected resource metadata (Node and Workers); `src/worker.ts` is the Cloudflare Worker; `src/cli.ts` is `npx @revenuedot/mcp` (stdio, or `--http`).

Rules
- Use RevenueCat's tool name when a tool does the same thing (see their tools reference); keep the set small and well described.
- Every tool is a thin call to the REST API v2. Auth and scope checks live in the server, never here.
- No approval/HITL tools: MCP clients ask the user before writes.
- OAuth lives in the server (`apps/server/src/routes/oauth.ts`); access tokens are project-scoped secret keys, so this server only passes the bearer token through.
- Tests run every tool against a real RevenueDot server started in-process from `../revenuedot` (`REVENUEDOT_REPO`). Keep them green: `pnpm typecheck && pnpm test`.
- Hosted at `https://mcp.revenuedot.app/mcp` (worker `revenuedot-mcp`). `.github/workflows/ci.yml` tests every push and deploys from `main` after the tests pass, so pushing to `main` is a production deploy. Use Node 24. `@revenuedot/mcp` is not on npm yet.
- Record decisions in files and commit them. Private material goes to `revenuedot/company`, never here.
