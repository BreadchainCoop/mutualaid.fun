import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained index.html (JS + WASM inlined) so StatiCrypt can
// encrypt the whole app as a single file. inlineDynamicImports also
// collapses the subduction glue into one chunk, fixing the duplicate
// "expected instance of Topic" from separate dynamic-import chunks.
export default defineConfig({
  root: "web",
  plugins: [wasm(), viteSingleFile({ removeViteModuleLoader: true })],
  // New orgs are encrypted, so keyhive has to be in the bundle or creating one
  // fails outright. KEYHIVE=0 drops it (and ~1 MB gzipped of inlined WASM) for
  // a build that will only ever open pre-encryption orgs; the constant folds
  // away and rollup removes the dynamic import in src/store.ts.
  define: { __KEYHIVE_BUILD__: JSON.stringify(process.env.KEYHIVE !== "0") },
  resolve: {
    // Force the `import` condition so subduction resolves to web.js
    // (internally consistent web glue + inlined wasm), not the browser
    // bundler.js whose glue mismatch throws "expected instance of Topic".
    conditions: ["import", "module", "development", "default"],
    dedupe: ["@automerge/automerge", "@automerge/automerge-subduction", "@automerge/automerge-repo"],
  },
  build: {
    target: "esnext",
    outDir: "../dist-single",
    emptyOutDir: true,
    assetsInlineLimit: 100 * 1024 * 1024, // inline the WASM as base64
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
