import { z } from "zod";
import { guidelines, patterns, search, skills, snippets } from "./data.js";
import { MAINTAINED_BY, kit } from "./info.js";

/**
 * The six read-only knowledge tools served at /kit/mcp. None takes a credential, writes anything or calls a customer's account. Each returns Markdown
 * text that ends with the maintainer line, and the same data as structured content.
 */

export interface ToolResult { text: string; data: Record<string, unknown>; isError?: boolean }

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string; title: string; description: string; inputSchema: S;
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
  run(args: z.infer<z.ZodObject<S>>): ToolResult;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const define = <S extends z.ZodRawShape>(t: Omit<ToolDefinition<S>, "annotations">) => ({ ...t, annotations: READ }) as unknown as ToolDefinition;
const source = (s: { title: string; url: string }) => `[${s.title}](${s.url})`;
const TOOLKITS = ["swiftui", "compose", "react-native", "flutter"] as const;

const notFound = (what: string, id: string, valid: string[]): ToolResult => ({
  text: `No ${what} with id "${id}". Valid ids: ${valid.join(", ")}.`, data: { error: "not_found", validIds: valid }, isError: true,
});

export const tools: ToolDefinition[] = [
  define({
    name: "search-monetization-knowledge", title: "Search monetization knowledge",
    description: `Search ${kit.displayName}'s paywall patterns, store guidelines, code snippets and skills. Returns ranked passages, each with a source URL. Read-only; needs no account.`,
    inputSchema: {
      query: z.string().min(2).max(200).describe("What to look for, for example 'free trial disclosure' or 'restore purchases'."),
      kind: z.enum(["pattern", "guideline", "snippet", "skill"]).optional().describe("Only this kind of passage."),
      limit: z.number().int().min(1).max(10).optional().describe("How many passages, 1 to 10 (default 5)."),
    },
    run({ query, kind, limit }) {
      const results = search(query, limit ?? 5, kind);
      const text = results.length
        ? results.map((r, i) => `${i + 1}. **${r.title}** (${r.kind}, id \`${r.id}\`)\n   ${r.passage}\n   Source: ${r.sourceUrl}${r.checked ? ` (checked ${r.checked})` : ""}`).join("\n\n")
        : `No passages match "${query}". Try list-paywall-patterns or list-skills.`;
      return { text, data: { query, results } };
    },
  }),
  define({
    name: "list-paywall-patterns", title: "List paywall patterns",
    description: "List the paywall patterns with a one-line summary each. Use get-paywall-pattern for the full structure and rules.",
    inputSchema: {},
    run() {
      const items = patterns.map((p) => ({ id: p.id, name: p.name, summary: p.summary, sourceUrl: p.source.url, checked: p.checked }));
      return { text: items.map((p) => `- \`${p.id}\`: ${p.name}. ${p.summary}`).join("\n"), data: { patterns: items } };
    },
  }),
  define({
    name: "get-paywall-pattern", title: "Get a paywall pattern",
    description: "Get one paywall pattern: its structure, when it works, when to avoid it, the rules it must follow, and implementation notes for a UI toolkit. Cites its source and check date.",
    inputSchema: {
      id: z.string().describe("Pattern id from list-paywall-patterns, for example 'annual-first'."),
      toolkit: z.enum(TOOLKITS).optional().describe("Only this toolkit's implementation note."),
    },
    run({ id, toolkit }) {
      const p = patterns.find((x) => x.id === id);
      if (!p) return notFound("paywall pattern", id, patterns.map((x) => x.id));
      const impl = toolkit ? { [toolkit]: p.implementation[toolkit] } : p.implementation;
      const gl = p.guidelineIds.map((g) => guidelines.find((x) => x.id === g)).filter((g) => !!g);
      const text = [
        `# ${p.name}`, p.summary, "",
        "## Structure", ...p.structure.map((s) => `- ${s}`), "",
        `## When it works\n${p.whenItWorks}`, `## When to avoid it\n${p.whenToAvoid}`, "",
        "## Rules", ...p.rules.map((r) => `- ${r}`), "",
        "## Implementation", ...Object.entries(impl).map(([k, v]) => `- ${k}: ${v}`), "",
        ...(gl.length ? ["## Related store guidelines", ...gl.map((g) => `- \`${g.id}\`: ${g.title}`), ""] : []),
        `Evidence: ${p.evidence}`,
        `Source: ${source(p.source)} (checked ${p.checked})`,
        ...(p.related?.length ? [`Also: ${p.related.map(source).join(", ")}`] : []),
      ].join("\n");
      return { text, data: { pattern: { ...p, implementation: impl } } };
    },
  }),
  define({
    name: "get-store-guideline", title: "Get a store guideline",
    description: "Get an App Store or Google Play rule with its policy link and what it means in practice. Without an id, lists the available guidelines, optionally for one store.",
    inputSchema: {
      id: z.string().optional().describe("Guideline id, for example 'apple-3-1-2a-trial-disclosure'. Omit to list."),
      store: z.enum(["apple", "google"]).optional().describe("When listing, only this store."),
    },
    run({ id, store }) {
      if (!id) {
        const items = guidelines.filter((g) => !store || g.store === store).map((g) => ({ id: g.id, store: g.store, title: g.title }));
        return { text: items.map((g) => `- \`${g.id}\` (${g.store}): ${g.title}`).join("\n"), data: { guidelines: items } };
      }
      const g = guidelines.find((x) => x.id === id);
      if (!g) return notFound("store guideline", id, guidelines.map((x) => x.id));
      return {
        text: [`# ${g.title}`, `Store: ${g.store}`, "", `## Rule\n${g.rule}`, `## In practice\n${g.inPractice}`, "", `Source: ${source(g.source)} (checked ${g.checked}). Policies change: read the source before you rely on it.`].join("\n"),
        data: { guideline: g },
      };
    },
  }),
  define({
    name: "get-code-snippet", title: "Get a code snippet",
    description: "Get a code snippet by id, or find snippets by platform (ios, android, react-native, flutter, server), task (configure, purchase, acknowledge, webhook-verification) and backend (revenuedot or store-native). Each says whether it was executed here or copied from the docs.",
    inputSchema: {
      id: z.string().optional().describe("Snippet id, for example 'ios-configure'."),
      platform: z.string().optional().describe("ios, android, react-native, flutter or server."),
      task: z.string().optional().describe("configure, purchase, acknowledge or webhook-verification."),
      backend: z.enum(["revenuedot", "store-native"]).optional().describe("Which backend the snippet uses."),
    },
    run({ id, platform, task, backend }) {
      const show = (s: (typeof snippets)[number]) => `## ${s.title}\n\n\`\`\`${s.language}\n${s.code}\n\`\`\`\n\n${s.notes}\nStatus: ${s.status}. Source: ${source(s.source)} (checked ${s.checked}).`;
      if (id) {
        const s = snippets.find((x) => x.id === id);
        return s ? { text: show(s), data: { snippets: [s] } } : notFound("code snippet", id, snippets.map((x) => x.id));
      }
      const hits = snippets.filter((s) => (!platform || s.platform === platform) && (!task || s.task === task) && (!backend || s.backend === backend));
      if (!hits.length) return { text: `No snippet matches. Available ids: ${snippets.map((s) => s.id).join(", ")}.`, data: { snippets: [] } };
      return { text: hits.map(show).join("\n\n"), data: { snippets: hits } };
    },
  }),
  define({
    name: "list-skills", title: "List the monetization skills",
    description: `List the monetization skills in ${kit.displayName} and when to use each.`,
    inputSchema: {},
    run() {
      return { text: skills.map((s) => `- \`${s.name}\`: ${s.description}`).join("\n"), data: { skills } };
    },
  }),
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));

/** Runs a tool and appends the maintainer line to its text. */
export function runTool(name: string, args: unknown) {
  const tool = toolsByName.get(name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  const parsed = z.object(tool.inputSchema).parse(args ?? {});
  const r = tool.run(parsed as never);
  return { text: `${r.text}\n\n${MAINTAINED_BY}`, data: r.data, isError: r.isError ?? false };
}
