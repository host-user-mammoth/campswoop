// Render CampSwoop app icons (PNG) from the swoop mark.
const path = require("path");
const { chromium } = require("playwright");
const out = process.argv[2];
const mark = '<path fill="#ff4a1c" d="M10 39.5c9.6-.9 16.3-5.6 20.7-14.1 3.6 6.8 9.8 12.4 20.8 14.1-11.3 3.4-17.5 1.9-20.8-2.7-4.4 4.7-11 5.9-20.7 2.7z"/>';
const glow = '<defs><radialGradient id="g" cx="50%" cy="56%" r="50%"><stop offset="0" stop-color="#ff4a1c" stop-opacity=".22"/><stop offset="1" stop-color="#ff4a1c" stop-opacity="0"/></radialGradient></defs><rect width="64" height="64" fill="#0b0a09"/><rect width="64" height="64" fill="url(#g)"/>';
const icons = [["icon-192.png", 192, 1], ["icon-512.png", 512, 1], ["apple-touch-icon.png", 180, 1], ["icon-maskable-512.png", 512, 0.72]];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, size, scale] of icons) {
    await page.setViewportSize({ width: size, height: size });
    const t = (1 - scale) * 32;
    await page.setContent(`<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" style="display:block">${glow}<g transform="translate(${t} ${t}) scale(${scale})">${mark}</g></svg></body></html>`);
    await page.screenshot({ path: path.join(out, name) });
    console.log("wrote", name);
  }
  await browser.close();
})();
