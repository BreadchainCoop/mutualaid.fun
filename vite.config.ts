import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  root: "web",
  plugins: [wasm()],
  build: {
    target: "esnext",
    outDir: "../dist",
    emptyOutDir: true,
  },
  optimizeDeps: {
    // The subduction WASM package auto-initializes on import; pre-bundling
    // breaks its asset URL resolution.
    exclude: ["@automerge/automerge-subduction", "@automerge/automerge"],
  },
  resolve: {
    // Force the `import` condition so @automerge/automerge-subduction
    // resolves to its internally-consistent `web.js` (web glue + inlined
    // wasm) rather than the `browser` entry `bundler.js`, whose glue
    // mismatch throws "expected instance of Topic" on ephemeral subscribe.
    conditions: ["import", "module", "development", "default"],
    dedupe: [
      "@automerge/automerge",
      "@automerge/automerge-subduction",
      "@automerge/automerge-repo",
    ],
  },
});
