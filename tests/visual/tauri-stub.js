(() => {
  const opts = window.__EZ_STUB__ ?? {};
  let nextId = 1;
  const callbacks = new Map();

  const answers = {
    get_startup_args: () => ({ filePath: opts.startupFile ?? null, shouldPrint: false, unsaved: false }),
    get_page_count: () => opts.pages ?? 1,
    list_system_fonts: () => opts.fonts ?? [],
    read_annotations: () => [],
    strip_annotation_streams: () => false,
    temp_tag: () => "visual",
    is_default_pdf_reader: () => true,
    check_pdf_association: () => true,
    list_printers: () => [],
    ocr_languages: () => [{ tag: "en-US", name: "English" }],
    existing_files: () => [],
    open_pages_dialog: () => [],
    open_document_dialog: () => null,
    save_pdf_dialog: () => null,
    "plugin:path|resolve_directory": () => "/tmp",
    "plugin:path|basename": (a) => String(a.path).split(/[\\/]/).pop(),
    "plugin:path|dirname": (a) => String(a.path).replace(/[\\/][^\\/]*$/, ""),
    "plugin:path|extname": (a) => (String(a.path).match(/\.([^.\\/]+)$/) ?? [, ""])[1],
    "plugin:path|join": (a) => a.paths.join("/"),
    "plugin:path|normalize": (a) => a.path,
    "plugin:path|resolve": (a) => a.paths.join("/"),
    "plugin:path|is_absolute": (a) => String(a.path).startsWith("/"),
    "plugin:event|listen": () => nextId++,
    "plugin:window|is_maximized": () => false,
    "plugin:window|is_fullscreen": () => false,
    "plugin:window|scale_factor": () => 1,
    "plugin:window|inner_size": () => ({ width: innerWidth, height: innerHeight }),
    "plugin:window|outer_size": () => ({ width: innerWidth, height: innerHeight }),
    "plugin:window|current_monitor": () => null,
  };

  window.__EZ_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: {},
    transformCallback(cb, once) {
      const id = nextId++;
      callbacks.set(id, (x) => { if (once) callbacks.delete(id); return cb?.(x); });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    runCallback(id, data) { callbacks.get(id)?.(data); },
    callbacks,
    async invoke(cmd, args = {}) {
      window.__EZ_CALLS__.push(cmd);
      const answer = answers[cmd];
      return answer ? answer(args) : null;
    },
    convertFileSrc(path) {
      return `/__fixtures__/${encodeURIComponent(String(path).split(/[\\/]/).pop())}`;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
