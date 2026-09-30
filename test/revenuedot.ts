import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";

/**
 * Starts a real RevenueDot server in-process from the monorepo checkout (REVENUEDOT_REPO, default ../revenuedot),
 * on an in-memory Postgres (PGlite), listening on a random local port.
 */
export const REPO = process.env.REVENUEDOT_REPO ?? resolve(import.meta.dirname, "../../revenuedot");

export function listen(fetch: (r: Request) => Response | Promise<Response>): Promise<{ url: string; server: ServerType }> {
  return new Promise((ok) => {
    const server = serve({ fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => ok({ url: `http://127.0.0.1:${info.port}`, server }));
  });
}

export interface RevenueDot {
  url: string;
  cookie: string;
  projectId: string;
  apps: { test: string; ios: string };
  key: string;
  readOnlyKey: string;
  signup(email: string, projectName: string): Promise<{ cookie: string; projectId: string }>;
  close(): Promise<void>;
}

export async function startRevenueDot(): Promise<RevenueDot> {
  const mod = (p: string) => import(pathToFileURL(resolve(REPO, p)).href);
  const { openDb } = await mod("packages/db/src/index.ts");
  const { createApp } = await mod("apps/server/src/app.ts");
  const { defaultStores } = await mod("apps/server/src/stores/index.ts");
  const { db, close } = await openDb("pglite://memory");
  const app = createApp({ db, now: () => new Date(), stores: defaultStores(), signingKey: "" });
  const { url, server } = await listen(app.fetch);

  const json = async (method: string, path: string, body: unknown, headers: Record<string, string>) => {
    const res = await fetch(url + path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return { res, body: (await res.json()) as any };
  };
  const signup = async (email: string, projectName: string) => {
    const { res } = await json("POST", "/auth/signup", { email, password: "correct horse battery", project_name: projectName }, {});
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await fetch(`${url}/auth/me`, { headers: { cookie } })).json() as { projects: { id: string }[] };
    return { cookie, projectId: me.projects[0]!.id };
  };

  const owner = await signup("owner@example.com", "Scanner");
  const as = { cookie: owner.cookie };
  const P = `/v2/projects/${owner.projectId}`;
  const test = (await json("POST", `${P}/apps`, { name: "Test Store", type: "test_store" }, as)).body.id as string;
  const ios = (await json("POST", `${P}/apps`, { name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.scanner" } }, as)).body.id as string;
  const key = (await json("POST", `${P}/api_keys`, { name: "mcp tests" }, as)).body.key as string;
  const readOnlyKey = (await json("POST", `${P}/api_keys`, {
    name: "read only",
    permissions: ["project_configuration:projects:read", "project_configuration:entitlements:read", "customer_information:customers:read"],
  }, as)).body.key as string;

  return {
    url, cookie: owner.cookie, projectId: owner.projectId, apps: { test, ios }, key, readOnlyKey, signup,
    close: async () => { await new Promise<void>((ok) => server.close(() => ok())); await close(); },
  };
}
