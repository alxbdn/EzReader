/**
 * Options every pdf.js `getDocument` call starts from. A PDF is untrusted:
 * pdf.js must never build code from it (`isEvalSupported` would compile
 * font programs with `new Function`, the path of CVE-2024-4367). The app
 * never loads pdf.js's scripting module, so a PDF's JavaScript never runs.
 */
export const SAFE_PDF = { isEvalSupported: false } as const;
