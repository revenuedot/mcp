// Checks a tools/list result against what the ChatGPT app directory and the Claude connector directory require.
// Used by test/listing.test.ts (against the code) and scripts/verify-live.mjs (against the deployed server).

const SECRET_NAME = /(secret|password|passphrase|private_?key|api_?key|access_?token|bearer|credential|authorization)/i;
const INJECTION = /(ignore (all |any )?(previous|prior|above)|disregard|system prompt|do not (tell|inform|mention)|don't tell|<important>|you must always|always call this tool|before using any other tool)/i;

/** @param {any[]} tools the `tools` array of a tools/list response @param {{ count?: number }} [opts] @returns {string[]} problems, empty when the list passes */
export function checkListing(tools, opts = {}) {
  const problems = [];
  const add = (tool, msg) => problems.push(`${tool}: ${msg}`);
  if (opts.count !== undefined && tools.length !== opts.count) problems.push(`expected ${opts.count} tools, found ${tools.length}`);
  const seen = new Set();
  for (const t of tools) {
    const n = t.name ?? "(no name)";
    if (seen.has(n)) add(n, "duplicate name");
    seen.add(n);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(n)) add(n, "name must be 1 to 64 characters of letters, digits, _ or -");
    if (!t.title || t.title.length > 60) add(n, "needs a title of at most 60 characters");
    const d = t.description ?? "";
    if (d.length < 40) add(n, "description is shorter than 40 characters");
    if (d.length > 1000) add(n, "description is longer than 1000 characters");
    if (INJECTION.test(d) || INJECTION.test(t.title ?? "")) add(n, "description reads like an instruction to the model rather than a description");
    const a = t.annotations ?? {};
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) if (typeof a[k] !== "boolean") add(n, `annotation ${k} must be set to true or false`);
    if (a.readOnlyHint && a.destructiveHint) add(n, "a read-only tool cannot be destructive");
    if (!a.readOnlyHint && /^(delete|cancel|refund|revoke|archive)-/.test(n) && !a.destructiveHint) add(n, "deleting, cancelling, refunding, revoking and archiving tools must be destructive");
    if (a.readOnlyHint && /^(create|delete|cancel|refund|revoke|archive|grant|set|send|retry|extend|attach)-/.test(n)) add(n, "a tool named like a write is marked read-only");
    const schema = t.inputSchema ?? {};
    if (schema.type !== "object") add(n, "inputSchema must be an object schema");
    for (const [p, def] of Object.entries(schema.properties ?? {})) {
      if (!def.description) add(n, `property ${p} has no description`);
      if (SECRET_NAME.test(p)) add(n, `property ${p} looks like it takes a secret; credentials are entered in the dashboard, never in a tool call`);
    }
    const schemes = t._meta?.securitySchemes;
    if (!Array.isArray(schemes) || schemes[0]?.type !== "oauth2" || !schemes[0].scopes?.length) add(n, "_meta.securitySchemes must declare oauth2 with scopes");
    else if (a.readOnlyHint && schemes[0].scopes.some((s) => s !== "project:read")) add(n, "a read-only tool should need only project:read");
    else if (!a.readOnlyHint && !schemes[0].scopes.includes("project:write")) add(n, "a write tool must need project:write");
  }
  return problems;
}
