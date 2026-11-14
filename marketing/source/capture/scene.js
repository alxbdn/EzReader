// node scene.js <scene>   — drives the real EzReader UI (mocked Tauri) and saves a PNG
const { chromium } = require(process.env.PW || "playwright-core");
const path = require("path");
const OUT = path.join(__dirname, "..", "shots");
const scene = process.argv[2];

const list = (page) => page.evaluate(() => [...document.querySelectorAll("button")].filter(b => b.offsetParent)
  .map(b => (b.title || b.getAttribute("aria-label") || b.textContent.trim()).slice(0, 40)));
const t = (page, title) => page.click(`button[title^="${title}"]`);

const scenes = {
  async explore(page) {
    await page.goto(url("file=contract.pdf&zoom=fit-page"));
    await page.waitForTimeout(2000);
    await page.click("button.mode-btn:has-text('Annotate')");
    await page.waitForTimeout(500);
    console.log("ANNOTATE", await list(page));
    await page.click("button.mode-btn:has-text('Edit')");
    await page.waitForTimeout(500);
    console.log("EDIT", await list(page));
  },
};
scenes.reader = async (page) => {
  await page.goto(url("file=report.pdf&zoom=75"));
  await page.waitForTimeout(2000);
  await t(page, "Two pages per row");
  await page.waitForTimeout(1200);
};
scenes.brightness = async (page) => {
  await page.goto(url("file=report.pdf&zoom=fit-width&b=100"));
  await page.waitForTimeout(2000);
  await t(page, "Page brightness");
  await page.waitForTimeout(300);
  await page.evaluate(() => { const r = document.querySelector(".brightness-pop input[type=range]");
    r.value = "55"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(800);
};
scenes.export = async (page) => {
  await page.goto(url("file=report.pdf&zoom=fit-width"));
  await page.waitForTimeout(2000);
  await t(page, "Export or convert");
  await page.waitForTimeout(800);
};
scenes.sign = async (page) => {
  await page.goto(url("file=contract.pdf&zoom=fit-page"));
  await page.waitForTimeout(2000);
  await page.click("button.mode-btn:has-text('Annotate')");
  await t(page, "Sign");
  await page.waitForTimeout(400);
  await page.click("text=+ New signature");
  await page.waitForTimeout(600);
  const c = await page.$("#signature-canvas");
  if (c) {
    const b = await c.boundingBox();
    // a loose handwritten "A. Martin"-like scribble
    const strokes = [];
    // capital: tall loop
    { const p=[]; for(let i=0;i<=40;i++){const t=i/40; p.push([.07+.06*t+.03*Math.sin(t*Math.PI*2), .82-.62*Math.sin(t*Math.PI)]);} strokes.push(p); }
    // flowing cursive loops (prolate cycloid)
    { const p=[]; for(let i=0;i<=160;i++){const t=i/160*Math.PI*2*6.2; p.push([.15+ (0.018*t - 0.03*Math.sin(t)), .62 - .16*Math.cos(t)*(0.7+0.3*Math.sin(t/3)) + (i<10?0:0)]);} strokes.push(p); }
    // underline swoosh
    { const p=[]; for(let i=0;i<=30;i++){const t=i/30; p.push([.1+.82*t, .9-.12*t+.06*Math.sin(t*Math.PI)]);} strokes.push(p); }
    for (const s of strokes) {
      await page.mouse.move(b.x + s[0][0] * b.width, b.y + s[0][1] * b.height);
      await page.mouse.down();
      for (const [x, y] of s.slice(1)) await page.mouse.move(b.x + x * b.width, b.y + y * b.height, { steps: 2 });
      await page.mouse.up();
    }
  }
  await page.waitForTimeout(300);
  await page.click("#sig-place-btn");
  await page.waitForTimeout(500);
  const pr = await page.evaluate(() => { const c=[...document.querySelectorAll('canvas')].map(c=>c.getBoundingClientRect()).filter(r=>r.width>300)[0]; return c && {x:c.x,y:c.y,w:c.width,h:c.height}; });
  console.log(JSON.stringify(pr));
  const X = Number(process.env.SX||0), Y = Number(process.env.SY||0);
  if (X) { await page.mouse.move(pr.x + X*pr.w, pr.y + Y*pr.h); await page.waitForTimeout(200); await page.mouse.click(pr.x + X*pr.w, pr.y + Y*pr.h); }
  await page.waitForTimeout(Number(process.env.WAIT||0));
  if (process.env.SCROLL) await page.evaluate((y)=>document.getElementById('viewer-scroll').scrollTop=Number(y), process.env.SCROLL);
};
scenes.straighten = async (page) => {
  await page.goto(url("file=scan.pdf&zoom=75"));
  await page.waitForTimeout(2000);
  await page.click("button.mode-btn:has-text('Edit')");
  await page.click("button.sb-pill:has-text('Select all')");
  await page.waitForTimeout(300);
  await t(page, "Straighten");
  await page.waitForTimeout(1500);
  console.log(await page.evaluate(() => [...document.querySelectorAll('[class*=handle],[class*=corner]')].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect();return e.className+' '+Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2)})));
  console.log(await page.evaluate(() => [...document.querySelectorAll('canvas,img')].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect();return e.tagName+'.'+e.className+' '+[r.x,r.y,r.width,r.height].map(Math.round)})));
  const drags = JSON.parse(process.env.DRAGS || "[]");
  for (const [x1,y1,x2,y2] of drags) { await page.mouse.move(x1,y1); await page.mouse.down(); await page.mouse.move(x2,y2,{steps:12}); await page.mouse.up(); await page.waitForTimeout(400); }
  if (process.env.HOVER) { const [x,y]=JSON.parse(process.env.HOVER); await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+1,y+1); }
  await page.waitForTimeout(1500);
};
scenes.info = async (page) => {
  await page.goto(url("file=report.pdf&zoom=75"));
  await page.waitForTimeout(2000);
  await t(page, "Document info");
  await page.waitForTimeout(1000);
};
scenes.contract = async (page) => {
  await page.goto(url("file=contract.pdf&zoom=75"));
  await page.waitForTimeout(2000);
  await t(page, "Show or hide the page thumbnails");
  await page.waitForTimeout(800);
};
scenes.tide = async (page) => {
  await page.goto(url("file=report.pdf&zoom=100"));
  await page.waitForTimeout(2000);
  await page.click("button.page-nav-step[title^='Next page']");
  await page.waitForTimeout(1500);
};
scenes.protect = async (page) => {
  await page.goto(url("file=contract.pdf&zoom=75"));
  await page.waitForTimeout(2000);
  await t(page, "Protect with a password");
  await page.waitForTimeout(500);
  for (const i of await page.$$("input[type=password]")) await i.fill("correct-horse-battery");
  await page.waitForTimeout(800);
};
const url = (q) => "http://localhost:5173/?" + q;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 }, deviceScaleFactor: 2, colorScheme: "dark" });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.addInitScript({ path: path.join(__dirname, "mock.js") });
  await scenes[scene](page, t);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${scene}.png` });
  await browser.close();
})();

