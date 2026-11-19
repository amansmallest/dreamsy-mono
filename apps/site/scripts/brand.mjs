import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "components/Logo.tsx"), "utf8");

const grid = (name) => {
  const block = src.slice(src.indexOf(name));
  return [...block.slice(0, block.indexOf("];") + 2).matchAll(/"([.#]*)"/g)].map((m) => m[1]);
};
const glyphs = {};
for (const m of src.matchAll(/^\s+(\w): \[(.*)\],$/gm)) glyphs[m[1]] = [...m[2].matchAll(/"([.#]*)"/g)].map((x) => x[1]);
const spark = grid("const SPARK");

function wordmark(color) {
  const rects = [];
  const add = (row, x0, y) => [...row].forEach((c, i) => c === "#" && rects.push(`<rect x="${x0 + i}" y="${y}" width="1" height="1"/>`));
  let x = 0;
  for (const ch of "dreamsy") {
    const g = glyphs[ch];
    g.forEach((row, y) => add(row, x, y));
    x += Math.max(...g.map((r) => r.length)) + 1;
  }
  spark.forEach((row, y) => add(row, x + 1, y));
  const w = x + 1 + spark[0].length;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 13" shape-rendering="crispEdges" fill="${color}">${rects.join("")}</svg>`, w };
}

function mark(size, pad, bg, fg) {
  const d = glyphs.d;
  const cell = Math.floor((size - pad * 2) / 13);
  const ox = Math.round((size - 6 * cell) / 2), oy = Math.round((size - 11 * cell) / 2);
  const rects = [];
  d.forEach((row, y) => [...row].forEach((c, x) => c === "#" && rects.push(`<rect x="${ox + x * cell}" y="${oy + y * cell}" width="${cell}" height="${cell}"/>`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${bg}"/><g fill="${fg}">${rects.join("")}</g></svg>`;
}

const shot = (file) => `data:image/jpeg;base64,${readFileSync(join(root, "public/games", file)).toString("base64")}`;
const logo = wordmark("#1a7ff0");

const og = `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@700&family=Nunito:wght@600&display=block">
<style>
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:Nunito;color:#0f5ccc;
background:#f8fcff;background-image:linear-gradient(#dcedfb 1px,transparent 1px),linear-gradient(90deg,#dcedfb 1px,transparent 1px);background-size:24px 24px}
.copy{position:absolute;left:80px;top:96px;width:640px}
.logo{height:52px;display:block;margin-bottom:56px}
h1{margin:0;font:700 74px/1.12 "Pixelify Sans";color:#0f5ccc}
.hl{background:#1a7ff0;color:#fff;padding:0 10px}
p{margin:44px 0 0;font-size:27px;color:#4a6488}
.block{position:absolute;left:800px;top:120px;width:330px;height:450px;background:#1a7ff0;border:3px solid #1a7ff0}
.shadow{position:absolute;left:812px;top:132px;width:330px;height:450px;background:repeating-conic-gradient(#1a7ff0 0 25%,transparent 0 50%) 0 0/8px 8px}
.phone{position:absolute;left:840px;top:56px;width:270px;height:500px;background:#fff;border:4px solid #1a7ff0;border-radius:26px;padding:16px;box-shadow:10px 10px 0 #9fd1f6}
.phone img{display:block;width:100%;height:100%;object-fit:cover;object-position:top;border:3px solid #1a7ff0;border-radius:10px}
</style></head><body>
<div class="copy"><img class="logo" src="data:image/svg+xml;base64,${Buffer.from(logo.svg).toString("base64")}">
<h1>Describe a game.<br>Then <span class="hl">play it.</span></h1>
<p>Open source · 2D &amp; 2.5D · iOS, Android &amp; web</p></div>
<div class="shadow"></div><div class="block"></div>
<div class="phone"><img src="${shot("kit-platformer.jpg")}"></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(og, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
const ogPng = await page.screenshot({ type: "png" });
writeFileSync(join(root, "app/opengraph-image.png"), ogPng);
writeFileSync(join(root, "app/twitter-image.png"), ogPng);
writeFileSync(join(root, "app/opengraph-image.alt.txt"), "Dreamsy: describe a game, then play it. Open-source engine for 2D and 2.5D games.");
writeFileSync(join(root, "app/twitter-image.alt.txt"), "Dreamsy: describe a game, then play it. Open-source engine for 2D and 2.5D games.");

const icons = [
  ["public/icons/icon-192.png", mark(192, 30, "#1a7ff0", "#ffffff")],
  ["public/icons/icon-512.png", mark(512, 80, "#1a7ff0", "#ffffff")],
  ["public/icons/maskable-512.png", mark(512, 140, "#1a7ff0", "#ffffff")],
  ["app/apple-icon.png", mark(180, 34, "#1a7ff0", "#ffffff")],
];
for (const [file, svg] of icons) {
  const size = Number(/width="(\d+)"/.exec(svg)[1]);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  writeFileSync(join(root, file), await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: size, height: size } }));
}
writeFileSync(join(root, "app/icon.svg"), mark(64, 10, "#1a7ff0", "#ffffff"));
await browser.close();
console.log("wrote og image, twitter image, icons");
