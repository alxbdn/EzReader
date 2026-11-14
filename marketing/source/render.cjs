// Renders store.html (one slide per ?i=) to 3840x2160 PNGs in marketing/store-screenshots.
// Needs: the Vite dev server on :5173 (npx vite) and playwright-core with a local Chrome.
//   node marketing/source/render.cjs [index]
const { chromium } = require(process.env.PW || "playwright-core");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "store-screenshots");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const slides = (() => { const window = {}; eval(fs.readFileSync(path.join(__dirname, "slides.js"), "utf8")); return window.SLIDES; })();

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  const only = process.argv[2];
  for (let i = 0; i < slides.length; i++) {
    if (only !== undefined && String(i) !== only) continue;
    await page.goto(`http://localhost:5173/marketing/source/store.html?i=${i}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, `${slides[i].file}.png`) });
    console.log("wrote", slides[i].file);
  }
  await browser.close();
})();
