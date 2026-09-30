import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, RevenueDotApiError, type RevenueDotClient } from "../src/client.js";
import { runTool, toEpochMs, tools } from "../src/tools.js";
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
    ]);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z]+(-[a-z]+)+$/);
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.scopes.length).toBeGreaterThan(0);
      expect(t.annotations.readOnlyHint).toBe(t.name.startsWith("list-") || t.name.startsWith("get-"));
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
