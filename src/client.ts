/** A small client for the RevenueDot REST API v2 (RevenueCat's API v2 wire format). No MCP dependency. */

export const DEFAULT_BASE_URL = "https://api.revenuedot.app";

export interface ClientOptions {
  /** RevenueDot server, e.g. https://api.revenuedot.app or your self-hosted URL. */
  baseUrl?: string;
  /** A secret API key (sk_...). OAuth access tokens are secret keys too. */
  apiKey: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

/** An error answered by the API, in its own words (`type` is RevenueCat's error type, e.g. authorization_error). */
export class RevenueDotApiError extends Error {
  constructor(public status: number, public type: string, message: string, public param?: string) {
    super(message);
    this.name = "RevenueDotApiError";
  }
}

export type Query = Record<string, string | number | boolean | string[] | undefined | null>;

export interface RevenueDotClient {
  baseUrl: string;
  request<T = unknown>(method: string, path: string, opts?: { query?: Query; body?: unknown }): Promise<T>;
  /** The project to act on: `projectId` when given, else the only project the key can see. */
  project(projectId?: string): Promise<string>;
}

export function createClient(opts: ClientOptions): RevenueDotClient {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  let projects: Promise<{ id: string; name: string }[]> | null = null;

  async function request<T>(method: string, path: string, o: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x);
      else url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${opts.apiKey}`, accept: "application/json", "user-agent": opts.userAgent ?? "revenuedot-mcp" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(url, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    } catch (e) {
      throw new RevenueDotApiError(0, "network_error", `Could not reach the RevenueDot server at ${baseUrl}: ${e instanceof Error ? e.message : e}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const err = (json ?? {}) as { type?: string; message?: string; param?: string };
      throw new RevenueDotApiError(res.status, err.type ?? "http_error", err.message ?? `HTTP ${res.status} from ${method} ${path}`, err.param);
    }
    return json as T;
  }

  async function project(projectId?: string) {
    if (projectId) return projectId;
    projects ??= request<{ items: { id: string; name: string }[] }>("GET", "/v2/projects", { query: { limit: 100 } }).then((r) => r.items)
      .catch((e) => { projects = null; throw e; });
    const list = await projects;
    if (list.length === 1) return list[0]!.id;
    if (!list.length) throw new RevenueDotApiError(404, "resource_missing", "This key has no project. Create one in the RevenueDot dashboard.");
    throw new RevenueDotApiError(400, "parameter_error", `project_id is required: this account has ${list.length} projects (${list.map((p) => `${p.id} "${p.name}"`).join(", ")}).`, "project_id");
  }

  return { baseUrl, request, project };
}
