const svg = (viewBox: string, body: string): string =>
  `<svg width="20" height="14" viewBox="${viewBox}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

const vbands = (a: string, b: string, c: string): string =>
  svg("0 0 3 2", `<rect width="1" height="2" fill="${a}"/><rect x="1" width="1" height="2" fill="${b}"/><rect x="2" width="1" height="2" fill="${c}"/>`);

const hbands = (a: string, b: string, c: string): string =>
  svg("0 0 3 3", `<rect width="3" height="1" fill="${a}"/><rect y="1" width="3" height="1" fill="${b}"/><rect y="2" width="3" height="1" fill="${c}"/>`);

const STAR = "M0,-1 L0.2245,-0.309 L0.951,-0.309 L0.363,0.118 L0.588,0.809 L0,0.382 L-0.588,0.809 L-0.363,0.118 L-0.951,-0.309 L-0.2245,-0.309 Z";

const FLAGS: Record<string, string> = {
  en: svg("0 0 60 30",
    `<rect width="60" height="30" fill="#012169"/>` +
    `<path d="M0,0 60,30M60,0 0,30" stroke="#fff" stroke-width="6"/>` +
    `<path d="M0,0 60,30M60,0 0,30" stroke="#C8102E" stroke-width="2"/>` +
    `<path d="M30,0v30M0,15h60" stroke="#fff" stroke-width="10"/>` +
    `<path d="M30,0v30M0,15h60" stroke="#C8102E" stroke-width="6"/>`),
  fr: vbands("#002654", "#ffffff", "#CE1126"),
  es: svg("0 0 3 2", `<rect width="3" height="2" fill="#AA151B"/><rect y="0.5" width="3" height="1" fill="#F1BF00"/>`),
  de: hbands("#000000", "#DD0000", "#FFCE00"),
  ru: hbands("#ffffff", "#0039A6", "#D52B1E"),
  pt: svg("0 0 5 3", `<rect width="5" height="3" fill="#FF0000"/><rect width="2" height="3" fill="#006600"/><circle cx="2" cy="1.5" r="0.6" fill="#FFCC00"/>`),
  ja: svg("0 0 3 2", `<rect width="3" height="2" fill="#ffffff"/><circle cx="1.5" cy="1" r="0.6" fill="#BC002D"/>`),
  zh: svg("0 0 30 20", `<rect width="30" height="20" fill="#DE2910"/><path d="${STAR}" transform="translate(5,5) scale(3)" fill="#FFDE00"/>`),
  ko: svg("0 0 3 2",
    `<rect width="3" height="2" fill="#ffffff"/>` +
    `<path d="M1.5,0.5 a0.5,0.5 0 0 1 0,1 a0.25,0.25 0 0 1 0,-0.5 a0.25,0.25 0 0 0 0,-0.5 z" fill="#003478" transform="rotate(-56 1.5 1)"/>` +
    `<path d="M1.5,0.5 a0.5,0.5 0 0 0 0,1 a0.25,0.25 0 0 0 0,-0.5 a0.25,0.25 0 0 1 0,-0.5 z" fill="#CD2E3A" transform="rotate(-56 1.5 1)"/>`),
  hi: svg("0 0 3 2", `<rect width="3" height="2" fill="#ffffff"/><rect width="3" height="0.667" fill="#FF9933"/><rect y="1.333" width="3" height="0.667" fill="#138808"/><circle cx="1.5" cy="1" r="0.25" fill="none" stroke="#000080" stroke-width="0.06"/>`),
  bn: svg("0 0 10 6", `<rect width="10" height="6" fill="#006A4E"/><circle cx="4.5" cy="3" r="2" fill="#F42A41"/>`),
  ur: svg("0 0 3 2", `<rect width="3" height="2" fill="#01411C"/><rect width="0.75" height="2" fill="#ffffff"/><circle cx="1.9" cy="1" r="0.5" fill="#ffffff"/><circle cx="2.02" cy="0.9" r="0.42" fill="#01411C"/>`),
  id: svg("0 0 3 2", `<rect width="3" height="2" fill="#ffffff"/><rect width="3" height="1" fill="#CE1126"/>`),
  tr: svg("0 0 30 20", `<rect width="30" height="20" fill="#E30A17"/><circle cx="11" cy="10" r="5" fill="#ffffff"/><circle cx="12.25" cy="10" r="4" fill="#E30A17"/><path d="${STAR}" transform="translate(17.2,10) rotate(-18) scale(2)" fill="#ffffff"/>`),
  vi: svg("0 0 30 20", `<rect width="30" height="20" fill="#DA251D"/><path d="${STAR}" transform="translate(15,10.5) scale(6)" fill="#FFFF00"/>`),
};
FLAGS["mr"] = FLAGS["hi"]!;
FLAGS["te"] = FLAGS["hi"]!;
FLAGS["ta"] = FLAGS["hi"]!;

export const FLAG_GLOBE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;

export function flagFor(lang: string): string | null {
  return FLAGS[lang] ?? null;
}

export function flagMarkup(lang: string): string {
  const flag = flagFor(lang);
  return flag
    ? `<span class="lang-flag">${flag}</span>`
    : `<span class="lang-flag lang-flag-globe">${FLAG_GLOBE}</span>`;
}
