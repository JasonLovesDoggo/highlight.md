import { build } from "esbuild"

await Promise.all([
  build({
    entryPoints: ["src/plugin/main.ts"],
    bundle: true,
    external: ["obsidian", "@codemirror/state", "@codemirror/view"],
    format: "cjs",
    platform: "browser",
    target: "es2022",
    outfile: "plugin/main.js",
    sourcemap: false,
    logLevel: "info",
  }),
  build({
    entryPoints: ["src/mcp/server.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: "dist/mcp-server.js",
    sourcemap: false,
    logLevel: "info",
  }),
])
