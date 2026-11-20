import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
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
