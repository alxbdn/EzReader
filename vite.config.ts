import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { readFileSync } from "fs";
import { PDFJS_WASM_DIR, PDFJS_WASM_FILES } from "./src/pdf-wasm";

const wasmSource = (name: string) => readFileSync(resolve(import.meta.dirname, "node_modules/pdfjs-dist/wasm", name));

/** Ships pdf.js's image decoders (JPEG 2000, JBIG2, ICC) next to the app, at a fixed path. */
function pdfjsWasm(): Plugin {
  return {
    name: "pdfjs-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0].replace(`/${PDFJS_WASM_DIR}`, "");
        if (!req.url?.startsWith(`/${PDFJS_WASM_DIR}`) || !PDFJS_WASM_FILES.includes(name as never)) return next();
        res.setHeader("Content-Type", "application/wasm");
        res.end(wasmSource(name!));
      });
    },
    generateBundle() {
      for (const name of PDFJS_WASM_FILES) {
        this.emitFile({ type: "asset", fileName: PDFJS_WASM_DIR + name, source: wasmSource(name) });
      }
    },
  };
}

export default defineConfig({
  plugins: [pdfjsWasm()],
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
  },
  resolve: {
    // The legacy build of pdf.js ships the polyfills older WebKit needs
    // (Promise.withResolvers, Map.getOrInsertComputed...). macOS keeps the
    // WebKit of the Safari it came with, so Intel Macs stuck on macOS 12–14
    // threw while loading the modern build and showed a black window.
    alias: [{ find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" }],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // macOS 11 is the oldest system the app installs on (Safari 14 WebKit).
    target: ["es2020", "safari14"],
    rollupOptions: {
      input: resolve(import.meta.dirname, "index.html"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  clearScreen: false,
});
