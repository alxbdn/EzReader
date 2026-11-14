// Stand-in for the Tauri runtime so the real EzReader front end runs in Chromium.
(() => {
  const params = new URLSearchParams(location.search);
  const file = params.get("file");
  let cb = 1;
  const log = (window.__calls = []);
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (f) => { const id = cb++; window["_" + id] = f; return id; },
    unregisterCallback: () => {},
    convertFileSrc: (p) => "/marketing/source/samples/" + String(p).split(/[\/]/).pop(),
    invoke: async (cmd, args) => {
      log.push(cmd);
      switch (cmd) {
        case "get_startup_args": return { filePath: file, shouldPrint: false, unsaved: false };
        case "read_annotations": return [];
        case "check_pdf_association": return true;
        case "existing_files": return [];
        case "plugin:path|basename": return String(args.path).split(/[\\/]/).pop();
        case "plugin:path|dirname": return String(args.path).replace(/[\\/][^\\/]*$/, "");
        case "plugin:path|temp_dir": return "/tmp";
        case "plugin:path|resolve_directory": return "/tmp";
        case "plugin:event|listen": return cb++;
        case "plugin:window|scale_factor": return 1;
        case "plugin:window|is_maximized": return false;
        case "ocr_languages": return [];
        default: return null;
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  const settings = { language: "en", theme: "dark", defaultZoom: params.get("zoom") || "fit-width", pxPerInch: 96, pageBrightness: Number(params.get("b") || 100) };
  localStorage.setItem("pdf-rider-settings", JSON.stringify(settings));
})();
