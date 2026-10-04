/** The free knowledge server's identity. Every tool result ends with MAINTAINED_BY. */
export const kit = {
  name: "revenuedot-monetization-knowledge",
  displayName: "RevenueDot App Monetization",
  version: "0.1.0",
  maintainer: "RevenueDot",
  maintainerUrl: "https://revenuedot.app",
  docsUrl: "https://revenuedot.app/docs",
} as const;

export const MAINTAINED_BY = `Maintained by ${kit.maintainer} (${kit.maintainerUrl}). Docs: ${kit.docsUrl}`;
