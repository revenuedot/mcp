import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, RevenueDotApiError, type RevenueDotClient } from "../src/client.js";
import { oauthScopesFor, runTool, toEpochMs, tools } from "../src/tools.js";
import { startRevenueDot, type RevenueDot } from "./revenuedot.js";

/** Every tool executor against a real RevenueDot server (in-process, PGlite), in the order an agent sets up a project. */

let rd: RevenueDot;
let client: RevenueDotClient;
const run = (name: string, args: Record<string, unknown> = {}) => runTool(client, name, args) as Promise<any>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  rd = await startRevenueDot();
  client = createClient({ baseUrl: rd.url, apiKey: rd.key });
});
afterAll(async () => { await rd?.close(); });

describe("tool catalog", () => {
  it("has RevenueCat's kebab-case names plus the RevenueDot-only ones, each with a description, schema and scopes", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "list-projects", "list-apps", "list-products", "create-product", "list-entitlements", "create-entitlement", "attach-products-to-entitlement",
      "list-offerings", "create-offering", "create-packages", "attach-products-to-package", "get-customer", "grant-customer-entitlement",
      "revoke-customer-entitlement", "list-webhook-integrations", "create-webhook-integration", "get-import-status",
      "get-project-health", "get-metrics", "list-customers", "list-transactions", "list-events", "set-customer-attributes", "delete-customer",
      "extend-subscription", "cancel-subscription", "refund-subscription", "create-test-purchase", "archive-offering", "list-webhook-deliveries",
      "retry-webhook-delivery", "send-test-webhook", "delete-webhook-integration", "verify-store-credentials",
    ]);
    const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    expect(readOnly).toHaveLength(15);
    expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort()).toEqual(["archive-offering", "cancel-subscription", "delete-customer", "delete-webhook-integration", "refund-subscription", "revoke-customer-entitlement", "set-customer-attributes"]);
    expect(tools).toHaveLength(34);
    // Tools that reach Apple, Google or the owner's own webhook URL are open world (OpenAI's scan checks this).
    expect(tools.filter((t) => t.annotations.openWorldHint).map((t) => t.name).sort()).toEqual([
      "cancel-subscription", "create-offering", "create-test-purchase", "create-webhook-integration", "extend-subscription", "refund-subscription",
      "retry-webhook-delivery", "send-test-webhook", "verify-store-credentials",
    ]);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z]+(-[a-z]+)+$/);
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.scopes.length).toBeGreaterThan(0);
      // Reads never carry a write permission, and writes always do.
      expect(t.scopes.some((x) => x.endsWith(":read_write"))).toBe(!t.annotations.readOnlyHint);
    }
  });
});

describe("tools against a live RevenueDot server", () => {
  it("list-projects: the key sees its one project", async () => {
    const r = await run("list-projects");
    expect(r.items.map((p: any) => p.id)).toEqual([rd.projectId]);
  });

  it("list-apps: works without project_id (the key's only project) and with it", async () => {
    const r = await run("list-apps");
    expect(r.items.map((a: any) => a.type).sort()).toEqual(["app_store", "test_store"]);
    expect((await run("list-apps", { project_id: rd.projectId })).items).toHaveLength(2);
  });

  it("create-product and list-products", async () => {
    const m = await run("create-product", { app_id: rd.apps.test, store_identifier: "pro_monthly", type: "subscription", subscription_duration: "P1M", display_name: "Pro monthly" });
    expect(m).toMatchObject({ object: "product", store_identifier: "pro_monthly", type: "subscription", app_id: rd.apps.test });
    ids.testMonthly = m.id;
    ids.iosMonthly = (await run("create-product", { app_id: rd.apps.ios, store_identifier: "pro_monthly", type: "subscription", subscription_duration: "P1M" })).id;
    ids.testAnnual = (await run("create-product", { app_id: rd.apps.test, store_identifier: "pro_annual", type: "subscription", subscription_duration: "P1Y" })).id;
    expect((await run("list-products")).items).toHaveLength(3);
    const ios = await run("list-products", { app_id: rd.apps.ios });
    expect(ios.items.map((p: any) => p.id)).toEqual([ids.iosMonthly]);
    expect(ios.items[0].app).toMatchObject({ id: rd.apps.ios });
  });

  it("create-entitlement, attach-products-to-entitlement (by lookup key) and list-entitlements", async () => {
    const e = await run("create-entitlement", { lookup_key: "pro", display_name: "Pro access" });
    expect(e).toMatchObject({ object: "entitlement", lookup_key: "pro" });
    ids.pro = e.id;
    await run("attach-products-to-entitlement", { entitlement_id: "pro", product_ids: [ids.testMonthly, ids.iosMonthly, ids.testAnnual] });
    const list = await run("list-entitlements");
    expect(list.items).toHaveLength(1);
    expect(list.items[0].products.items.map((p: any) => p.id).sort()).toEqual([ids.testMonthly, ids.iosMonthly, ids.testAnnual].sort());
  });

  it("create-offering (first is current; is_current moves it), create-packages, attach-products-to-package, list-offerings", async () => {
    const def = await run("create-offering", { lookup_key: "default", display_name: "Standard" });
    expect(def.is_current).toBe(true);
    const promo = await run("create-offering", { lookup_key: "promo", display_name: "Promo", is_current: true, metadata: { headline: "50% off" } });
    expect(promo).toMatchObject({ lookup_key: "promo", is_current: true, metadata: { headline: "50% off" } });
    const monthly = await run("create-packages", { offering_id: def.id, lookup_key: "$rc_monthly", display_name: "Monthly" });
    const annual = await run("create-packages", { offering_id: def.id, lookup_key: "$rc_annual", display_name: "Annual" });
    expect(monthly).toMatchObject({ object: "package", lookup_key: "$rc_monthly", position: 0 });
    expect(annual.position).toBe(1);
    await run("attach-products-to-package", { package_id: monthly.id, product_ids: [ids.testMonthly, ids.iosMonthly] });
    await run("attach-products-to-package", { package_id: annual.id, product_ids: [ids.testAnnual] });
    const list = await run("list-offerings");
    const d = list.items.find((o: any) => o.id === def.id);
    expect(d.is_current).toBe(false);
    expect(list.items.find((o: any) => o.id === promo.id).is_current).toBe(true);
    const m = d.packages.items.find((p: any) => p.lookup_key === "$rc_monthly");
    expect(m.products.items.map((x: any) => x.product.id).sort()).toEqual([ids.testMonthly, ids.iosMonthly].sort());
  });

  it("grant-customer-entitlement creates a new customer, get-customer shows the access, revoke-customer-entitlement ends it", async () => {
    await expect(run("get-customer", { customer_id: "user_42" })).rejects.toMatchObject({ status: 404, type: "resource_missing" });
    const g = await run("grant-customer-entitlement", { customer_id: "user_42", entitlement_id: "pro", expires_at: "30d" });
    expect(g.active_entitlements.items.map((e: any) => e.entitlement_id)).toEqual([ids.pro]);
    // By entitlement id and with an ISO date, on the now-existing customer.
    await run("grant-customer-entitlement", { customer_id: "user_42", entitlement_id: ids.pro, expires_at: new Date(Date.now() + 90 * 86400_000).toISOString() });

    const c = await run("get-customer", { customer_id: "user_42" });
    expect(c).toMatchObject({ object: "customer", id: "user_42", project_id: rd.projectId });
    expect(c.active_entitlements.items[0].entitlement_id).toBe(ids.pro);
    expect(c.subscriptions.length).toBe(2);
    expect(c.subscriptions.every((s: any) => s.store === "promotional" && s.gives_access)).toBe(true);
    expect(c.purchases).toEqual([]);

    const r = await run("revoke-customer-entitlement", { customer_id: "user_42", entitlement_id: "pro" });
    expect(r.active_entitlements.items).toEqual([]);
    await expect(run("revoke-customer-entitlement", { customer_id: "user_42", entitlement_id: "pro" })).rejects.toMatchObject({ status: 404 });
    await expect(run("grant-customer-entitlement", { customer_id: "user_42", entitlement_id: "pro", expires_at: "2020-01-01" })).rejects.toMatchObject({ status: 400, param: "expires_at" });
  });

  it("create-webhook-integration returns the signing secret once; list-webhook-integrations lists it", async () => {
    const w = await run("create-webhook-integration", { name: "Backend", url: "https://example.com/hooks/revenuedot", environment: "production", event_types: ["initial_purchase", "renewal"] });
    expect(w).toMatchObject({ object: "webhook_integration", name: "Backend", url: "https://example.com/hooks/revenuedot", environment: "production", event_types: ["initial_purchase", "renewal"] });
    expect(typeof w.signing_secret).toBe("string");
    const list = await run("list-webhook-integrations");
    expect(list.items.map((x: any) => x.id)).toEqual([w.id]);
    expect(list.items[0].signing_secret).toBeUndefined();
  });

  it("get-import-status counts customers and subscriptions and pending Google tokens", async () => {
    expect(await run("get-import-status")).toEqual({ object: "import_status", customers: 1, subscriptions: 2, needs_token_refresh: 0, needs_token_refresh_by_app: {} });
  });

  it("errors carry the API's words: a read-only key names the missing permission; another project is not found", async () => {
    const ro = createClient({ baseUrl: rd.url, apiKey: rd.readOnlyKey });
    expect((await runTool(ro, "list-entitlements", {}) as any).items).toHaveLength(1);
    const err = await runTool(ro, "create-entitlement", { lookup_key: "vip", display_name: "VIP" }).catch((e) => e);
    expect(err).toBeInstanceOf(RevenueDotApiError);
    expect(err).toMatchObject({ status: 403, type: "authorization_error" });
    expect(err.message).toContain("project_configuration:entitlements:read_write");
    // get-customer still works without the subscriptions and purchases scopes, and says what is missing.
    const c = await runTool(ro, "get-customer", { customer_id: "user_42" }) as any;
    expect(c.subscriptions.error).toContain("customer_information:subscriptions:read");
    await expect(run("list-apps", { project_id: "proj_nope" })).rejects.toMatchObject({ status: 404 });
    await expect(runTool(createClient({ baseUrl: rd.url, apiKey: "sk_bad" }), "list-projects", {})).rejects.toMatchObject({ status: 401, type: "authentication_error" });
    await expect(run("create-product", { app_id: rd.apps.test, type: "subscription" })).rejects.toThrow(/store_identifier/);
    await expect(runTool(createClient({ baseUrl: "http://127.0.0.1:1", apiKey: rd.key }), "list-projects", {})).rejects.toMatchObject({ type: "network_error" });
  });
});

describe("support and operations tools against a live server", () => {
  const sub = async (customer: string) => (await run("get-customer", { customer_id: customer })).subscriptions[0];

  it("create-test-purchase runs a lifecycle through the real pipeline; list-customers, list-transactions and list-events find it", async () => {
    const t = await run("create-test-purchase", { app_user_id: "buyer_1", product_id: ids.testMonthly, scenario: "trial_conversion" });
    expect(t).toMatchObject({ object: "test_purchase", scenario: "trial_conversion" });
    expect(t.event_types.length).toBeGreaterThanOrEqual(2);
    await run("set-customer-attributes", { customer_id: "buyer_1", attributes: [{ name: "$email", value: "Buyer@Example.com" }, { name: "plan_note", value: "vip" }] });
    // Search by app user id and by email (case-insensitive), nothing for a stranger.
    expect((await run("list-customers", { search: "buyer_1" })).items.map((c: any) => c.id)).toEqual(["buyer_1"]);
    expect((await run("list-customers", { search: "buyer@example.com" })).items.map((c: any) => c.id)).toEqual(["buyer_1"]);
    expect((await run("list-customers", { search: "nobody" })).items).toEqual([]);
    expect((await run("list-customers")).items.map((c: any) => c.id)).toEqual(expect.arrayContaining(["buyer_1", "user_42"]));
    const tx = await run("list-transactions", { customer_id: "buyer_1", environment: "sandbox" });
    expect(tx.items.length).toBeGreaterThanOrEqual(2);
    expect(tx.items.every((x: any) => x.customer_id === "buyer_1" && x.environment === "sandbox")).toBe(true);
    const ev = await run("list-events", { customer_id: "buyer_1", types: ["INITIAL_PURCHASE"] });
    expect(ev.items.map((e: any) => e.type)).toEqual(["INITIAL_PURCHASE"]);
    expect((await run("list-events", { customer_id: "nobody" })).items).toEqual([]);
    const c = await run("get-customer", { customer_id: "buyer_1" });
    expect(c.subscriptions[0]).toMatchObject({ store: "test_store", gives_access: true });
  });

  it("set-customer-attributes: a null value removes the attribute", async () => {
    await run("set-customer-attributes", { customer_id: "buyer_1", attributes: [{ name: "plan_note", value: null }] });
    const c = await run("get-customer", { customer_id: "buyer_1" });
    const names = (c.attributes?.items ?? []).map((a: any) => a.name);
    expect(names).toContain("$email");
    expect(names).not.toContain("plan_note");
  });

  it("extend-subscription asks for exactly one extension; cancel and refund pass the store's answer through", async () => {
    const s = await sub("buyer_1");
    await expect(run("extend-subscription", { subscription_id: s.id })).rejects.toMatchObject({ status: 400 });
    await expect(run("extend-subscription", { subscription_id: s.id, extend_by_days: 3, extend_until: "2030-01-01" })).rejects.toMatchObject({ status: 400 });
    // The Test Store has no server-side extend, cancel or refund; the API says so in plain words and the tool passes it on.
    const e = await run("extend-subscription", { subscription_id: s.id, extend_by_days: 3 }).catch((x) => x);
    expect(e).toMatchObject({ status: 422 });
    expect(e.message).toMatch(/Test Store/);
    for (const name of ["cancel-subscription", "refund-subscription"]) {
      const r = await run(name, { subscription_id: s.id }).catch((x) => x);
      expect(r instanceof Error ? r.message : JSON.stringify(r)).toBeTruthy();
    }
    await expect(run("cancel-subscription", { subscription_id: "sub_nope" })).rejects.toMatchObject({ status: 404 });
  });

  it("get-metrics returns the overview, or one metric's history; get-project-health lists each app", async () => {
    const o = await run("get-metrics");
    expect(o.metrics.map((m: any) => m.id)).toEqual(expect.arrayContaining(["mrr", "revenue", "active_subscriptions"]));
    const sandbox = await run("get-metrics", { environment: "sandbox" });
    expect(sandbox.object).toBe("overview_metrics");
    const h = await run("get-metrics", { metric: "revenue", days: 7, environment: "sandbox" });
    expect(h).toMatchObject({ object: "metric_history", id: "revenue", days: 7 });
    await expect(run("get-metrics", { metric: "nope" })).rejects.toThrow();
    const health = await run("get-project-health");
    expect(health.apps.map((a: any) => a.id).sort()).toEqual([rd.apps.ios, rd.apps.test].sort());
  });

  it("verify-store-credentials checks saved credentials only: its input has no place for a secret", async () => {
    const t = tools.find((x) => x.name === "verify-store-credentials")!;
    expect(Object.keys(t.inputSchema).sort()).toEqual(["app_id", "project_id"]);
    const r = await run("verify-store-credentials", { app_id: rd.apps.ios });
    expect(r).toMatchObject({ object: "credentials_check", app_id: rd.apps.ios, valid: false });
    expect(typeof r.message).toBe("string");
  });

  it("webhooks: test event, delivery list, retry, delete", async () => {
    const w = await run("create-webhook-integration", { name: "Ops", url: "https://example.com/hooks/ops" });
    const sent = await run("send-test-webhook", { webhook_id: w.id });
    expect(JSON.stringify(sent)).toMatch(/TEST|test/);
    const d = await run("list-webhook-deliveries", { webhook_id: w.id });
    expect(d.items.length).toBeGreaterThanOrEqual(1);
    expect(d.items[0]).toMatchObject({ object: "webhook_delivery", webhook_integration_id: w.id });
    expect((await run("list-webhook-deliveries", { webhook_id: w.id, status: "delivered" })).items.every((x: any) => x.status === "delivered")).toBe(true);
    const retried = await run("retry-webhook-delivery", { webhook_id: w.id, delivery_id: d.items[0].id });
    expect(retried.id).toBe(d.items[0].id);
    await expect(run("retry-webhook-delivery", { webhook_id: w.id, delivery_id: "nope" })).rejects.toMatchObject({ status: 404 });
    const del = await run("delete-webhook-integration", { webhook_id: w.id });
    expect(del).toMatchObject({ object: "webhook_integration", id: w.id });
    await expect(run("send-test-webhook", { webhook_id: w.id })).rejects.toMatchObject({ status: 404 });
  });

  it("archive-offering refuses the current offering and hides another", async () => {
    const list = (await run("list-offerings")).items;
    const current = list.find((o: any) => o.is_current);
    const other = list.find((o: any) => !o.is_current);
    await expect(run("archive-offering", { offering_id: current.id })).rejects.toMatchObject({ status: 422 });
    expect(await run("archive-offering", { offering_id: other.id })).toMatchObject({ id: other.id });
  });

  it("delete-customer removes the customer", async () => {
    expect(await run("delete-customer", { customer_id: "buyer_1" })).toMatchObject({ object: "customer" });
    await expect(run("get-customer", { customer_id: "buyer_1" })).rejects.toMatchObject({ status: 404 });
  });

  it("scope requirements: reads need project:read, writes project:write, money actions also project:support", () => {
    const need = (name: string) => oauthScopesFor(tools.find((t) => t.name === name)!.scopes);
    expect(need("list-customers")).toEqual(["project:read"]);
    expect(need("grant-customer-entitlement")).toEqual(["project:write"]);
    expect(need("delete-webhook-integration")).toEqual(["project:write"]);
    for (const n of ["extend-subscription", "cancel-subscription", "refund-subscription", "create-test-purchase"]) expect(need(n)).toEqual(["project:write", "project:support"]);
    expect(tools.filter((t) => oauthScopesFor(t.scopes).includes("project:support")).map((t) => t.name)).toHaveLength(4);
  });
});

describe("toEpochMs", () => {
  const now = Date.UTC(2026, 8, 30, 12);
  it("reads milliseconds, seconds, ISO dates and durations from now", () => {
    expect(toEpochMs(1790000000000, now)).toBe(1790000000000);
    expect(toEpochMs(1790000000, now)).toBe(1790000000000);
    expect(toEpochMs("1790000000000", now)).toBe(1790000000000);
    expect(toEpochMs("2026-10-01T00:00:00Z", now)).toBe(Date.UTC(2026, 9, 1));
    expect(toEpochMs("7d", now)).toBe(now + 7 * 86400_000);
    expect(toEpochMs("12h", now)).toBe(now + 12 * 3600_000);
    expect(toEpochMs("1m", now)).toBe(Date.UTC(2026, 9, 30, 12));
    expect(toEpochMs("1y", now)).toBe(Date.UTC(2027, 8, 30, 12));
    expect(() => toEpochMs("soon", now)).toThrow(/cannot read/);
  });
});
