import { z } from "zod";
import { RevenueDotApiError, type RevenueDotClient } from "./client.js";

/**
 * RevenueDot tool definitions and executors. They depend only on zod and the API client, not on MCP, so the MCP server
 * and the in-app RevenueDot agent share them. Names match RevenueCat's MCP tools where the tool does the same thing,
 * so prompts written for RevenueCat's server work here. Each executor is one or two calls to the REST API v2; the
 * server checks the key's scopes, and a missing scope comes back as an error naming it.
 */

export interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  /** API v2 permissions the tool needs (for docs and for the in-app agent to hide tools a user cannot run). */
  scopes: string[];
  run(client: RevenueDotClient, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}

/** OAuth scopes (as the RevenueDot authorization server names them) a tool needs, worked out from the API permissions it uses. */
export function oauthScopesFor(scopes: string[]): string[] {
  if (scopes.some((x) => /^customer_information:(subscriptions|purchases):read_write$/.test(x))) return ["project:write", "project:support"];
  if (scopes.some((x) => x.endsWith(":read_write"))) return ["project:write"];
  return ["project:read"];
}

const define = <S extends z.ZodRawShape>(t: ToolDefinition<S>) => t as unknown as ToolDefinition;

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTROY: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const DESTROY_OPEN: ToolAnnotations = { ...DESTROY, openWorldHint: true };
// The tools below reach a system RevenueDot does not control (Apple, Google, or the owner's own webhook URL), so they are open world.
const CREATE_OPEN: ToolAnnotations = { ...CREATE, openWorldHint: true };
const ATTACH: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const projectId = z.string().optional().describe("RevenueDot project id (proj...). Optional when the key or account has exactly one project.");
const limit = z.number().int().min(1).max(100).optional().describe("Page size, 1 to 100 (default 20).");
const startingAfter = z.string().optional().describe("Cursor: the id of the last item of the previous page (from next_page).");
const environment = z.enum(["production", "sandbox"]).optional().describe("Only this environment (default: both).");
const customerArg = z.string().min(1).describe("The app user id (any alias works).");
const enc = encodeURIComponent;
const P = async (c: RevenueDotClient, id?: string) => `/v2/projects/${enc(await c.project(id))}`;

/** Entitlements may be named by id (entl...) or lookup key ("pro"); the API takes ids. */
async function entitlementId(c: RevenueDotClient, base: string, idOrKey: string) {
  if (/^entl/.test(idOrKey)) return idOrKey;
  const list = await c.request<{ items: { id: string; lookup_key: string }[] }>("GET", `${base}/entitlements`, { query: { limit: 100 } });
  return list.items.find((e) => e.id === idOrKey || e.lookup_key === idOrKey)?.id ?? idOrKey;
}

/** Timestamps: milliseconds since epoch, an ISO 8601 date, or a duration from now such as "30d", "12h", "1y". */
export function toEpochMs(v: number | string, now = Date.now()): number {
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  const s = v.trim();
  const d = /^(\d+)\s*(h|d|w|m|y)$/i.exec(s);
  if (d) {
    const n = Number(d[1]);
    const unit = d[2]!.toLowerCase();
    if (unit === "m" || unit === "y") { const t = new Date(now); t.setUTCMonth(t.getUTCMonth() + n * (unit === "y" ? 12 : 1)); return t.getTime(); }
    return now + n * { h: 3600_000, d: 86400_000, w: 7 * 86400_000 }[unit as "h" | "d" | "w"];
  }
  if (/^\d+$/.test(s)) return toEpochMs(Number(s), now);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new RevenueDotApiError(400, "parameter_error", `expires_at: cannot read "${v}" as a date. Use milliseconds, an ISO date or a duration such as 30d.`, "expires_at");
  return t;
}

export const tools: ToolDefinition[] = [
  define({
    name: "list-projects", title: "List projects",
    description: "Lists the RevenueDot projects this key or account can use. A secret key sees its own project; an OAuth connection sees the project the user picked.",
    inputSchema: { limit, starting_after: startingAfter }, annotations: READ, scopes: ["project_configuration:projects:read"],
    run: (c, a) => c.request("GET", "/v2/projects", { query: { limit: a.limit, starting_after: a.starting_after } }),
  }),
  define({
    name: "list-apps", title: "List apps",
    description: "Lists the project's apps (one per store: app_store, play_store, test_store, stripe ...), with their ids. Product creation needs an app id.",
    inputSchema: { project_id: projectId, limit, starting_after: startingAfter }, annotations: READ, scopes: ["project_configuration:apps:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/apps`, { query: { limit: a.limit ?? 100, starting_after: a.starting_after } }),
  }),
  define({
    name: "list-products", title: "List products",
    description: "Lists the project's products (store product ids per app), optionally for one app.",
    inputSchema: { project_id: projectId, app_id: z.string().optional().describe("Only this app's products."), limit, starting_after: startingAfter },
    annotations: READ, scopes: ["project_configuration:products:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/products`, { query: { app_id: a.app_id, limit: a.limit ?? 100, starting_after: a.starting_after, expand: "items.app" } }),
  }),
  define({
    name: "create-product", title: "Create product",
    description: "Creates a product for one app. store_identifier is the product id in the store (App Store product id, Play subscription id such as pro:monthly, or any id for the Test Store). Set subscription_duration for subscriptions.",
    inputSchema: {
      project_id: projectId,
      app_id: z.string().describe("The app the product belongs to (see list-apps)."),
      store_identifier: z.string().min(1).describe("The store's product id, e.g. pro_monthly."),
      type: z.enum(["subscription", "one_time", "consumable", "non_consumable", "non_renewing_subscription"]).describe("Product type. Use subscription for auto-renewing plans."),
      display_name: z.string().optional().describe("Name shown in the dashboard."),
      subscription_duration: z.string().optional().describe("ISO 8601 period for subscriptions: P1W, P1M, P3M, P6M, P1Y."),
    },
    annotations: CREATE, scopes: ["project_configuration:products:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/products`, {
      body: { app_id: a.app_id, store_identifier: a.store_identifier, type: a.type, display_name: a.display_name, ...(a.subscription_duration ? { subscription: { duration: a.subscription_duration } } : {}) },
    }),
  }),
  define({
    name: "list-entitlements", title: "List entitlements",
    description: "Lists the project's entitlements (access levels such as pro) with the products that unlock each one.",
    inputSchema: { project_id: projectId, limit, starting_after: startingAfter }, annotations: READ, scopes: ["project_configuration:entitlements:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/entitlements`, { query: { limit: a.limit ?? 100, starting_after: a.starting_after, expand: "items.product" } }),
  }),
  define({
    name: "create-entitlement", title: "Create entitlement",
    description: "Creates an entitlement. lookup_key is what the app checks, e.g. customerInfo.entitlements[\"pro\"].",
    inputSchema: { project_id: projectId, lookup_key: z.string().min(1).describe("e.g. pro"), display_name: z.string().min(1).describe("e.g. Pro access") },
    annotations: CREATE, scopes: ["project_configuration:entitlements:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/entitlements`, { body: { lookup_key: a.lookup_key, display_name: a.display_name } }),
  }),
  define({
    name: "attach-products-to-entitlement", title: "Attach products to entitlement",
    description: "Makes products unlock an entitlement. Attach every store's version of a plan (iOS, Android, Test Store).",
    inputSchema: { project_id: projectId, entitlement_id: z.string().describe("Entitlement id (entl...) or lookup key."), product_ids: z.array(z.string()).min(1).max(50).describe("Product ids (prod...).") },
    annotations: ATTACH, scopes: ["project_configuration:entitlements:read_write"],
    run: async (c, a) => {
      const base = await P(c, a.project_id);
      const id = await entitlementId(c, base, a.entitlement_id);
      return c.request("POST", `${base}/entitlements/${enc(id)}/actions/attach_products`, { body: { product_ids: a.product_ids } });
    },
  }),
  define({
    name: "list-offerings", title: "List offerings",
    description: "Lists the project's offerings with their packages and each package's products. The current offering (is_current) is what the SDK shows by default.",
    inputSchema: { project_id: projectId, limit, starting_after: startingAfter }, annotations: READ, scopes: ["project_configuration:offerings:read", "project_configuration:packages:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/offerings`, { query: { limit: a.limit ?? 100, starting_after: a.starting_after, expand: "items.package.product" } }),
  }),
  define({
    name: "create-offering", title: "Create offering",
    description: "Creates an offering (a set of packages the paywall shows). The project's first offering becomes current; set is_current to make this one current.",
    inputSchema: {
      project_id: projectId, lookup_key: z.string().min(1).describe("e.g. default"), display_name: z.string().min(1).describe("Name shown in the dashboard."),
      is_current: z.boolean().optional().describe("Serve this offering to apps by default."),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Free-form JSON the app can read (paywall copy, colors ...)."),
    },
    annotations: CREATE_OPEN, scopes: ["project_configuration:offerings:read_write"],
    run: async (c, a) => {
      const base = await P(c, a.project_id);
      const o = await c.request<{ id: string; is_current: boolean }>("POST", `${base}/offerings`, { body: { lookup_key: a.lookup_key, display_name: a.display_name, metadata: a.metadata } });
      if (a.is_current && !o.is_current) return c.request("POST", `${base}/offerings/${enc(o.id)}`, { body: { is_current: true } });
      return o;
    },
  }),
  define({
    name: "create-packages", title: "Create package",
    description: "Creates a package in an offering. Use RevenueCat's standard lookup keys where they fit: $rc_monthly, $rc_annual, $rc_weekly, $rc_lifetime, $rc_six_month, $rc_three_month, $rc_two_month. Then attach products with attach-products-to-package.",
    inputSchema: {
      project_id: projectId, offering_id: z.string().describe("Offering id (ofrng...)."), lookup_key: z.string().min(1).describe("e.g. $rc_monthly."), display_name: z.string().min(1).describe("Name shown in the dashboard."),
      position: z.number().int().min(0).optional().describe("Order in the offering, 0 first. Default: last."),
    },
    annotations: CREATE, scopes: ["project_configuration:packages:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/offerings/${enc(a.offering_id)}/packages`, { body: { lookup_key: a.lookup_key, display_name: a.display_name, position: a.position } }),
  }),
  define({
    name: "attach-products-to-package", title: "Attach products to package",
    description: "Puts products in a package, at most one per app (e.g. the iOS, Android and Test Store monthly products in $rc_monthly).",
    inputSchema: {
      project_id: projectId, package_id: z.string().describe("Package id (pkge...)."),
      product_ids: z.array(z.string()).min(1).max(50).describe("Product ids (prod...)."),
      eligibility_criteria: z.enum(["all", "google_sdk_lt_6", "google_sdk_ge_6"]).optional().describe("Google Play SDK eligibility; default all."),
    },
    annotations: ATTACH, scopes: ["project_configuration:packages:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/packages/${enc(a.package_id)}/actions/attach_products`, {
      body: { products: a.product_ids.map((product_id) => ({ product_id, eligibility_criteria: a.eligibility_criteria ?? "all" })) },
    }),
  }),
  define({
    name: "get-customer", title: "Get customer",
    description: "Looks up a customer by app user id: active entitlements, attributes, subscriptions (gives_access says whether each one grants access now) and one-time purchases.",
    inputSchema: { project_id: projectId, customer_id: z.string().min(1).describe("The app user id (any alias works).") },
    annotations: READ, scopes: ["customer_information:customers:read", "customer_information:subscriptions:read", "customer_information:purchases:read"],
    run: async (c, a) => {
      const base = `${await P(c, a.project_id)}/customers/${enc(a.customer_id)}`;
      const customer = await c.request<Record<string, unknown>>("GET", base, { query: { expand: "attributes" } });
      // Subscriptions and purchases need their own scopes; a key without them still gets the customer.
      const optional = async (path: string) => {
        try { return (await c.request<{ items: unknown[] }>("GET", `${base}/${path}`, { query: { limit: 100 } })).items; }
        catch (e) { if (e instanceof RevenueDotApiError && e.status === 403) return { error: e.message }; throw e; }
      };
      return { ...customer, subscriptions: await optional("subscriptions"), purchases: await optional("purchases") };
    },
  }),
  define({
    name: "grant-customer-entitlement", title: "Grant entitlement to customer",
    description: "Gives a customer promotional access to an entitlement until expires_at, without a store purchase. The customer is created if new. Granting again with the same end date does nothing.",
    inputSchema: {
      project_id: projectId, customer_id: z.string().min(1).describe("The app user id."),
      entitlement_id: z.string().describe("Entitlement id (entl...) or lookup key such as pro."),
      expires_at: z.union([z.number(), z.string()]).describe("When access ends: milliseconds since epoch, an ISO 8601 date, or a duration from now such as 7d, 1m or 1y."),
    },
    annotations: { ...CREATE, idempotentHint: true }, scopes: ["customer_information:customers:read_write"],
    run: async (c, a) => {
      const pbase = await P(c, a.project_id);
      const id = await entitlementId(c, pbase, a.entitlement_id);
      const grant = () => c.request("POST", `${pbase}/customers/${enc(a.customer_id)}/actions/grant_entitlement`, { body: { entitlement_id: id, expires_at: toEpochMs(a.expires_at) } });
      try {
        return await grant();
      } catch (e) {
        // Support often grants access before the app has ever seen the user: create the customer, then grant.
        if (!(e instanceof RevenueDotApiError && e.status === 404 && /^Customer/.test(e.message))) throw e;
        await c.request("POST", `${pbase}/customers`, { body: { id: a.customer_id } });
        return grant();
      }
    },
  }),
  define({
    name: "revoke-customer-entitlement", title: "Revoke granted entitlement",
    description: "Ends promotional access that was granted to a customer (with grant-customer-entitlement or the dashboard). Store purchases are not affected.",
    inputSchema: { project_id: projectId, customer_id: customerArg, entitlement_id: z.string().describe("Entitlement id (entl...) or lookup key.") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, scopes: ["customer_information:customers:read_write"],
    run: async (c, a) => {
      const pbase = await P(c, a.project_id);
      const id = await entitlementId(c, pbase, a.entitlement_id);
      return c.request("POST", `${pbase}/customers/${enc(a.customer_id)}/actions/revoke_granted_entitlement`, { body: { entitlement_id: id } });
    },
  }),
  define({
    name: "list-webhook-integrations", title: "List webhooks",
    description: "Lists the project's webhook integrations (URL, environment and event filters).",
    inputSchema: { project_id: projectId, limit, starting_after: startingAfter }, annotations: READ, scopes: ["project_configuration:integrations:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/integrations/webhooks`, { query: { limit: a.limit ?? 100, starting_after: a.starting_after } }),
  }),
  define({
    name: "create-webhook-integration", title: "Create webhook",
    description: "Adds a webhook that receives RevenueCat-format events (INITIAL_PURCHASE, RENEWAL, CANCELLATION, EXPIRATION ...). The response includes the signing secret once: tell the user to store it now, it cannot be shown again. A custom Authorization header for the endpoint is set in the dashboard.",
    inputSchema: {
      project_id: projectId, name: z.string().min(1).describe("A label for the webhook, e.g. Backend."), url: z.string().url().describe("https URL that receives POSTs."),
      environment: z.enum(["production", "sandbox"]).optional().describe("Only events from this environment. Default: both."),
      event_types: z.array(z.string()).optional().describe("Only these event types, lower case (initial_purchase, renewal ...). Default: all."),
      app_id: z.string().optional().describe("Only events from this app."),
    },
    annotations: CREATE_OPEN, scopes: ["project_configuration:integrations:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/integrations/webhooks`, {
      body: { name: a.name, url: a.url, environment: a.environment, event_types: a.event_types, app_id: a.app_id },
    }),
  }),
  define({
    name: "get-import-status", title: "Get import status",
    description: "After `npx revenuedot import` from RevenueCat: how many customers and subscriptions the project holds, and how many Google Play subscriptions still wait for a purchase token (per app).",
    inputSchema: { project_id: projectId }, annotations: READ, scopes: ["customer_information:customers:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/import/status`),
  }),
  define({
    name: "get-project-health", title: "Get project health",
    description: "Setup health in one call: for each app whether the store credentials work and notifications arrive, plus whether webhooks are being delivered. Use it first when something looks wrong.",
    inputSchema: { project_id: projectId }, annotations: READ, scopes: ["project_configuration:apps:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/setup_health`),
  }),
  define({
    name: "get-metrics", title: "Get revenue metrics",
    description: "Without metric: the overview cards (MRR, revenue, active subscriptions, active trials, new customers, active customers, last 28 days, USD). With metric: that metric's daily history over `days` days.",
    inputSchema: {
      project_id: projectId,
      metric: z.enum(["active_trials", "active_subscriptions", "mrr", "revenue", "new_customers", "active_users"]).optional().describe("Leave out for the overview."),
      days: z.number().int().min(1).max(366).optional().describe("History length in days (default 28). Only with metric."),
      environment: z.enum(["production", "sandbox"]).optional().describe("Default production; sandbox shows Test Store and sandbox purchases."),
    },
    annotations: READ, scopes: ["charts_metrics:overview:read"],
    run: async (c, a) => {
      const base = await P(c, a.project_id);
      return a.metric
        ? c.request("GET", `${base}/metrics/history`, { query: { metric: a.metric, days: a.days, environment: a.environment } })
        : c.request("GET", `${base}/metrics/overview`, { query: { environment: a.environment } });
    },
  }),
  define({
    name: "list-customers", title: "Find customers",
    description: "Newest customers first, or a search: an exact app user id, the $email attribute, or a store transaction id. Use it to find who a support request is about, then call get-customer.",
    inputSchema: { project_id: projectId, search: z.string().optional().describe("App user id, email or store transaction id (exact match)."), limit, starting_after: startingAfter },
    annotations: READ, scopes: ["customer_information:customers:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/customers`, { query: { search: a.search, limit: a.limit, starting_after: a.starting_after } }),
  }),
  define({
    name: "list-transactions", title: "List transactions",
    description: "Every purchase, renewal, trial start and refund, newest first, with price and USD revenue. Optionally one customer's or one environment's.",
    inputSchema: { project_id: projectId, customer_id: z.string().optional().describe("Only this app user id."), environment, limit, starting_after: startingAfter },
    annotations: READ, scopes: ["customer_information:purchases:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/transactions`, { query: { customer: a.customer_id, environment: a.environment, limit: a.limit, starting_after: a.starting_after } }),
  }),
  define({
    name: "list-events", title: "List events",
    description: "The event log, newest first: the same events webhooks send (INITIAL_PURCHASE, RENEWAL, CANCELLATION, BILLING_ISSUE, EXPIRATION ...). Filter by customer, type or environment to see why a customer lost access.",
    inputSchema: {
      project_id: projectId, customer_id: z.string().optional().describe("Only this app user id."),
      types: z.array(z.string()).max(20).optional().describe("Only these event types, e.g. [\"CANCELLATION\", \"EXPIRATION\"]."), environment, limit, starting_after: startingAfter,
    },
    annotations: READ, scopes: ["customer_information:customers:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/events`, { query: { customer: a.customer_id, type: a.types, environment: a.environment, limit: a.limit, starting_after: a.starting_after } }),
  }),
  define({
    name: "set-customer-attributes", title: "Set customer attributes",
    description: "Sets attributes on a customer ($email, $displayName, or your own keys). A null value deletes the attribute.",
    inputSchema: {
      project_id: projectId, customer_id: customerArg,
      attributes: z.array(z.object({ name: z.string().min(1).max(500), value: z.string().nullable() })).min(1).max(50).describe("Name and value pairs; a null value deletes the attribute."),
    },
    annotations: { ...ATTACH, destructiveHint: true }, scopes: ["customer_information:customers:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/customers/${enc(a.customer_id)}/attributes`, { body: { attributes: a.attributes } }),
  }),
  define({
    name: "delete-customer", title: "Delete customer",
    description: "Permanently deletes a customer and their data from this project (for a data-deletion request). Store subscriptions are not cancelled. Ask the user to confirm the app user id first.",
    inputSchema: { project_id: projectId, customer_id: customerArg },
    annotations: DESTROY, scopes: ["customer_information:customers:read_write"],
    run: async (c, a) => c.request("DELETE", `${await P(c, a.project_id)}/customers/${enc(a.customer_id)}`),
  }),
  define({
    name: "extend-subscription", title: "Extend subscription",
    description: "Gives a subscriber more time at no charge: by days, or until a date. Works on Google Play and App Store subscriptions (App Store needs a reason and at most 90 days). Take the subscription id from get-customer.",
    inputSchema: {
      project_id: projectId, subscription_id: z.string().min(1).describe("Subscription id from get-customer."),
      extend_by_days: z.number().int().min(1).optional().describe("Days to add. Use this or extend_until."),
      extend_until: z.union([z.number(), z.string()]).optional().describe("New end of access: milliseconds since epoch or an ISO 8601 date. Use this or extend_by_days."),
      reason: z.enum(["undeclared", "customer_satisfaction", "other", "service_issue_or_outage"]).optional().describe("Required by Apple."),
    },
    annotations: CREATE_OPEN, scopes: ["customer_information:subscriptions:read_write"],
    run: async (c, a) => {
      if ((a.extend_by_days === undefined) === (a.extend_until === undefined)) throw new RevenueDotApiError(400, "parameter_error", "Send exactly one of extend_by_days and extend_until.", "extend_by_days");
      const body = a.extend_by_days !== undefined
        ? { extend_by_days: a.extend_by_days, extend_reason_code: a.reason }
        : { extend_until_ms: toEpochMs(a.extend_until!), extend_reason_code: a.reason };
      return c.request("POST", `${await P(c, a.project_id)}/subscriptions/${enc(a.subscription_id)}/actions/extend`, { body });
    },
  }),
  define({
    name: "cancel-subscription", title: "Cancel subscription",
    description: "Cancels a subscription at the end of the paid period (the customer keeps access until then). Works where the store lets a server cancel (Google Play); others answer with an error that says so. Ask the user to confirm first.",
    inputSchema: { project_id: projectId, subscription_id: z.string().min(1).describe("Subscription id from get-customer.") },
    annotations: DESTROY_OPEN, scopes: ["customer_information:subscriptions:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/subscriptions/${enc(a.subscription_id)}/actions/cancel`),
  }),
  define({
    name: "refund-subscription", title: "Refund subscription",
    description: "Refunds the latest charge and ends access immediately. Works where the store lets a server refund (Google Play); others answer with an error that says so. Money moves: only call it after the user said yes to this exact customer and amount.",
    inputSchema: { project_id: projectId, subscription_id: z.string().min(1).describe("Subscription id from get-customer.") },
    annotations: DESTROY_OPEN, scopes: ["customer_information:subscriptions:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/subscriptions/${enc(a.subscription_id)}/actions/refund`),
  }),
  define({
    name: "create-test-purchase", title: "Create Test Store purchase",
    description: "Simulates a purchase lifecycle in the project's Test Store for one app user, through the same pipeline as a real purchase (events, transactions, webhooks). Never touches Apple or Google. Use it to check that entitlements and webhooks work.",
    inputSchema: {
      project_id: projectId, app_user_id: z.string().min(1).max(100).describe("The app user id to buy as; created if new."), product_id: z.string().min(1).describe("Product id (prod...) or store identifier of a Test Store product."),
      scenario: z.enum(["purchase", "trial", "trial_conversion", "renewal", "cancel", "billing_issue", "refund", "expire"]).optional().describe("Lifecycle to simulate (default purchase)."),
      offset_days: z.number().min(0).max(730).optional().describe("How many days ago it started."),
    },
    annotations: CREATE_OPEN, scopes: ["customer_information:purchases:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/test_purchases`, { body: { app_user_id: a.app_user_id, product_id: a.product_id, scenario: a.scenario, offset_days: a.offset_days } }),
  }),
  define({
    name: "archive-offering", title: "Archive offering",
    description: "Hides an offering from apps without deleting it (it can be unarchived in the dashboard). The current offering cannot be archived.",
    inputSchema: { project_id: projectId, offering_id: z.string().describe("Offering id (ofrng...).") },
    annotations: DESTROY_OPEN, scopes: ["project_configuration:offerings:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/offerings/${enc(a.offering_id)}/actions/archive`),
  }),
  define({
    name: "list-webhook-deliveries", title: "List webhook deliveries",
    description: "Delivery attempts for one webhook, newest first, with status, attempts, HTTP status and last error. Filter by status to find failures.",
    inputSchema: {
      project_id: projectId, webhook_id: z.string().describe("Webhook integration id (see list-webhook-integrations)."),
      status: z.enum(["pending", "delivered", "failed"]).optional().describe("Only deliveries in this state."), limit, starting_after: startingAfter,
    },
    annotations: READ, scopes: ["project_configuration:integrations:read"],
    run: async (c, a) => c.request("GET", `${await P(c, a.project_id)}/webhooks/${enc(a.webhook_id)}/deliveries`, { query: { status: a.status, limit: a.limit, starting_after: a.starting_after } }),
  }),
  define({
    name: "retry-webhook-delivery", title: "Retry webhook delivery",
    description: "Sends a failed or pending webhook delivery again now.",
    inputSchema: { project_id: projectId, webhook_id: z.string().describe("Webhook integration id."), delivery_id: z.string().describe("Delivery id from list-webhook-deliveries.") },
    annotations: { ...ATTACH, openWorldHint: true }, scopes: ["project_configuration:integrations:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/webhooks/${enc(a.webhook_id)}/deliveries/${enc(a.delivery_id)}/retry`),
  }),
  define({
    name: "send-test-webhook", title: "Send test webhook",
    description: "Sends a TEST event to a webhook integration so the user can see it arrive. The webhook must be enabled.",
    inputSchema: { project_id: projectId, webhook_id: z.string().describe("Webhook integration id.") },
    annotations: CREATE_OPEN, scopes: ["project_configuration:integrations:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/integrations/webhooks/${enc(a.webhook_id)}/test`),
  }),
  define({
    name: "delete-webhook-integration", title: "Delete webhook",
    description: "Deletes a webhook integration and its delivery history. Events stop being sent to its URL.",
    inputSchema: { project_id: projectId, webhook_id: z.string().describe("Webhook integration id.") },
    annotations: DESTROY, scopes: ["project_configuration:integrations:read_write"],
    run: async (c, a) => c.request("DELETE", `${await P(c, a.project_id)}/integrations/webhooks/${enc(a.webhook_id)}`),
  }),
  define({
    name: "verify-store-credentials", title: "Verify store credentials",
    description: "Checks the Apple or Google credentials already saved for an app by calling the store, and says whether they work. It never accepts or returns a key: credentials are entered in the dashboard.",
    inputSchema: { project_id: projectId, app_id: z.string().describe("The app to check (see list-apps).") },
    annotations: { ...READ, openWorldHint: true }, scopes: ["project_configuration:apps:read"],
    run: async (c, a) => c.request("POST", `${await P(c, a.project_id)}/apps/${enc(a.app_id)}/actions/verify_credentials`, { body: {} }),
  }),
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));

/** Runs a tool by name with raw (unvalidated) arguments: validates them with the tool's schema first. */
export async function runTool(client: RevenueDotClient, name: string, args: unknown): Promise<unknown> {
  const t = toolsByName.get(name);
  if (!t) throw new Error(`Unknown tool: ${name}`);
  const parsed = z.object(t.inputSchema).parse(args ?? {});
  return t.run(client, parsed);
}
