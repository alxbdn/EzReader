import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { readFileSync, readdirSync } from "fs";
import { PDFJS_ASSETS, PDFJS_ASSETS_DIR, shippedFiles, type PdfjsAssetDir } from "./src/pdf-assets.ts";

const PDFJS_DIST = resolve(import.meta.dirname, "node_modules/pdfjs-dist");
const ASSET_DIRS = Object.keys(PDFJS_ASSETS) as PdfjsAssetDir[];
const assetFiles = (dir: PdfjsAssetDir) => shippedFiles(dir, readdirSync(resolve(PDFJS_DIST, dir)));
const CONTENT_TYPES: Record<string, string> = { ".wasm": "application/wasm", ".ttf": "font/ttf" };

function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        const [dir, name] = path.startsWith(`/${PDFJS_ASSETS_DIR}`) ? path.slice(PDFJS_ASSETS_DIR.length + 1).split("/") : [];
        if (!ASSET_DIRS.includes(dir as PdfjsAssetDir) || !assetFiles(dir as PdfjsAssetDir).includes(name)) return next();
        res.setHeader("Content-Type", CONTENT_TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream");
        res.end(readFileSync(resolve(PDFJS_DIST, dir, name)));
      });
    },
    generateBundle() {
      for (const dir of ASSET_DIRS) {
        for (const name of assetFiles(dir)) {
          this.emitFile({ type: "asset", fileName: `${PDFJS_ASSETS_DIR}${dir}/${name}`, source: readFileSync(resolve(PDFJS_DIST, dir, name)) });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssets()],
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
  },
  resolve: {
    alias: [{ find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" }],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
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
