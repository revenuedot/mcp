// Builds the Cloudflare Worker (config: cloudflare.config.ts) for `cf dev`, `cf build` and `cf deploy`.
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [cloudflare()] });
