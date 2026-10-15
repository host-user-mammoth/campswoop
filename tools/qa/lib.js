'use strict';
// Shared pieces of shoot.js and interact.js: CLI flags, browser launch + WebGL probe,
// viewport presets, the CampSwoop API mock, and per-page error recording.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { parseArgs } = require('node:util');

// The rig keeps its own Chromium in ./browsers (npm run install-browsers). Playwright reads this
// variable when it loads, so it must be set before require('playwright'). Without ./browsers,
// Playwright's shared cache (%LOCALAPPDATA%\ms-playwright) is used.
const LOCAL_BROWSERS = path.join(__dirname, 'browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(LOCAL_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS;
}
const { chromium } = require('playwright');
const { startServer } = require('./serve');

// Software WebGL (SwiftShader through ANGLE): the same pixels on any machine, GPU or not.
const WEBGL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const SCHEMES = ['light', 'dark'];

const API_ORIGIN = 'https://api.campswoop.com';
const MOCK_API = {
  'POST /signup': { ok: true, message: 'Almost done: we emailed a confirm link to you@example.com. Tap it to start your alerts.' },
  'POST /requested': { ok: true },
};

// Flags both tools share. Each tool adds its own and passes defaults.
const COMMON_OPTIONS = {
  root: { type: 'string' },
  out: { type: 'string' },
  hash: { type: 'string' },
  viewports: { type: 'string' },
  schemes: { type: 'string' },
  'reduced-motion': { type: 'boolean', default: false },
  'wait-for': { type: 'string' },
  'wait-ms': { type: 'string' },
  'mock-api': { type: 'boolean', default: false },
  name: { type: 'string' },
  channel: { type: 'string' },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

function fail(message) {
  console.error(message);
  process.exit(2);
}

const list = (value, fallback) => (value ? value.split(',').map(s => s.trim()).filter(Boolean) : fallback);

function int(value, fallback, flag) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${flag} needs a whole number of milliseconds, got "${value}"`);
  return n;
}

// desktop, mobile, or WxH / WxH@scale (e.g. 768x1024@2) for an extra breakpoint.
function viewportPreset(name) {
  if (VIEWPORTS[name]) return { name, ...VIEWPORTS[name] };
  const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(name);
  if (!m) fail(`Unknown viewport "${name}". Use desktop, mobile, or WxH[@scale] such as 768x1024@2.`);
  return { name, viewport: { width: +m[1], height: +m[2] }, deviceScaleFactor: m[3] ? +m[3] : 1, isMobile: false, hasTouch: false };
}

function parseCli(usage, { extraOptions = {}, defaults }) {
  let parsed;
  try {
    parsed = parseArgs({ options: { ...COMMON_OPTIONS, ...extraOptions }, strict: true, allowPositionals: false });
  } catch (err) {
    fail(`${err.message}\n\n${usage}`);
  }
  const v = parsed.values;
  if (v.help) { console.log(usage); process.exit(0); }
  if (!v.root || !v.out) fail(`--root and --out are required.\n\n${usage}`);
  const root = path.resolve(v.root);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) fail(`--root is not a folder: ${root}`);
  const schemes = list(v.schemes, defaults.schemes);
  for (const s of schemes) if (!SCHEMES.includes(s)) fail(`Unknown scheme "${s}". Use light and/or dark.`);
  return {
    values: v,
    root,
    out: path.resolve(v.out),
    hashes: list(v.hash, ['']).map(h => h.replace(/^#/, '')),
    viewports: list(v.viewports, defaults.viewports).map(viewportPreset),
    schemes,
    reducedMotion: v['reduced-motion'],
    waitFor: v['wait-for'] || null,
    waitMs: int(v['wait-ms'], 0, '--wait-ms'),
    mockApi: v['mock-api'],
    name: v.name || defaults.name,
    channel: v.channel && v.channel !== 'headless-shell' ? v.channel : undefined,
    timeout: int(v.timeout, 15000, '--timeout'),
  };
}

const slug = text => String(text).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');

async function launch(channel, { mockApi = false } = {}) {
  const args = [...WEBGL_ARGS];
  // With the mock on, also make the real API host unresolvable: a request the mock never sees
  // (a keepalive fetch or sendBeacon, say) then fails instead of reaching production.
  if (mockApi) args.push(`--host-resolver-rules=MAP ${new URL(API_ORIGIN).hostname} ~NOTFOUND`);
  return chromium.launch({ headless: true, channel, args });
}

// Runs in the page: WebGL2 (or 1) context, unmasked renderer, a real draw + readPixels, and codecs.
function probeInPage() {
  const out = { webgl: { webgl2: false, webgl1: false }, media: {} };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  let gl = canvas.getContext('webgl2');
  out.webgl.webgl2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl');
  out.webgl.webgl1 = !!gl;
  if (gl) {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    out.webgl.vendor = gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR);
    out.webgl.renderer = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    out.webgl.version = gl.getParameter(gl.VERSION);
    out.webgl.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    // Draw one red triangle over a blue clear and read the centre pixel back.
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'precision mediump float; void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }'));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      out.webgl.drawTest = `fail (link: ${gl.getProgramInfoLog(program)})`;
    } else {
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 16, 16);
      gl.clearColor(0, 0, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(4);
      gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.webgl.drawTest = px[0] === 255 && px[1] === 0 && px[2] === 0 ? 'pass' : `fail (pixel ${px.join(',')})`;
    }
  }
  const video = document.createElement('video');
  out.media.mp4_h264 = video.canPlayType('video/mp4; codecs="avc1.42E01E"') || 'no';
  out.media.webm_vp9 = video.canPlayType('video/webm; codecs="vp9"') || 'no';
  out.media.mp4_av1 = video.canPlayType('video/mp4; codecs="av01.0.05M.08"') || 'no';
  return out;
}

async function probe(browser, channel) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const result = await page.evaluate(probeInPage);
    result.browser = { channel: channel || 'chromium-headless-shell', version: browser.version() };
    return result;
  } finally {
    await context.close();
  }
}

function printProbe(result) {
  const { webgl, media, browser } = result;
  console.log(`Browser: ${browser.channel} ${browser.version}`);
  if (webgl.webgl2 || webgl.webgl1) {
    console.log(`WebGL: ${webgl.webgl2 ? 'webgl2' : 'webgl1 only'}, draw test ${webgl.drawTest}, renderer: ${webgl.renderer}`);
  } else {
    console.log('WARNING: WebGL is NOT available in this browser; canvas/3D content will not render.');
  }
  if (webgl.drawTest && webgl.drawTest !== 'pass') console.log(`WARNING: WebGL draw test ${webgl.drawTest}`);
  console.log(`Video: mp4/H.264 ${media.mp4_h264}, webm/VP9 ${media.webm_vp9}, mp4/AV1 ${media.mp4_av1}`);
}

async function newContext(browser, opts, vp, scheme) {
  const context = await browser.newContext({
    viewport: vp.viewport,
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    colorScheme: scheme,
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
  });
  context.setDefaultTimeout(opts.timeout);
  context.setDefaultNavigationTimeout(Math.max(opts.timeout, 30000));
  return context;
}

function newRecord(fields) {
  return { ...fields, problems: [], consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], httpErrors: [], dialogs: [], apiCalls: [] };
}

// Answers https://api.campswoop.com/** locally and notes each call (with its JSON body) in record.apiCalls.
// Playwright itself answers the CORS preflight; the replies here carry the CORS headers fetch() needs.
async function installMockApi(context, record) {
  await context.route(`${API_ORIGIN}/**`, async route => {
    const request = route.request();
    const headers = await request.allHeaders();
    const cors = {
      'Access-Control-Allow-Origin': headers.origin || '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': headers['access-control-request-headers'] || 'Content-Type',
      Vary: 'Origin',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const call = `${request.method()} ${new URL(request.url()).pathname}`;
    const reply = MOCK_API[call];
    let body = request.postData();
    try { body = JSON.parse(body); } catch { /* not JSON: keep the text */ }
    record.apiCalls.push({ call, body, mocked: !!reply });
    await route.fulfill({
      status: reply ? 200 : 404,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify(reply || { ok: false, error: `the QA mock has no answer for ${call}` }),
    });
  });
}

// Records console errors/warnings, uncaught page errors, failed requests, HTTP >= 400 and dialogs.
// Returns a function that stops recording; call it before closing the context so teardown isn't logged.
function watchPage(page, record) {
  let active = true;
  page.on('console', msg => {
    if (!active || (msg.type() !== 'error' && msg.type() !== 'warning')) return;
    const loc = msg.location();
    const entry = { text: msg.text() };
    if (loc && loc.url) entry.at = `${loc.url}:${loc.lineNumber + 1}:${loc.columnNumber + 1}`;
    (msg.type() === 'error' ? record.consoleErrors : record.consoleWarnings).push(entry);
  });
  page.on('pageerror', err => {
    if (active) record.pageErrors.push({ message: err.message, stack: err.stack });
  });
  page.on('requestfailed', req => {
    if (!active) return;
    const error = (req.failure() && req.failure().errorText) || 'failed';
    const entry = { url: req.url(), method: req.method(), type: req.resourceType(), error };
    // Chromium cancels media range requests on purpose once it has buffered enough.
    if (error === 'net::ERR_ABORTED' && req.resourceType() === 'media') entry.benign = true;
    record.failedRequests.push(entry);
  });
  page.on('response', res => {
    if (active && res.status() >= 400) record.httpErrors.push({ url: res.url(), status: res.status(), method: res.request().method() });
  });
  page.on('dialog', dialog => {
    if (active) record.dialogs.push({ type: dialog.type(), message: dialog.message() });
    dialog.dismiss().catch(() => {});
  });
  return () => { active = false; };
}

// After load: web fonts (up to 5 s), the optional --wait-for selector and --wait-ms, then two painted frames.
async function settle(page, opts, record) {
  await page.evaluate(() => Promise.race([
    document.fonts ? document.fonts.ready.then(() => true) : true,
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ])).catch(() => {});
  if (opts.waitFor) {
    try {
      await page.waitForSelector(opts.waitFor, { state: 'visible', timeout: opts.timeout });
    } catch {
      record.problems.push(`--wait-for "${opts.waitFor}" was not visible within ${opts.timeout} ms`);
    }
  }
  if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    setTimeout(() => resolve(true), 1000);
  })).catch(() => {});
}

// --scroll / {"scroll": "through"}: scroll the document from the top to the bottom in steps of 80% of
// the viewport height with 120 ms pauses (so IntersectionObserver fade-ins fire), back to the top, then
// wait 600 ms for the last transitions. A page that grows while scrolling (lazy content) is followed,
// up to 400 steps. Only the document scrolls; an inner scroll container is not swept.
async function scrollThrough(page) {
  const started = Date.now();
  const result = await page.evaluate(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const limit = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) - innerHeight;
    const step = Math.max(1, Math.round(innerHeight * 0.8));
    let y = 0;
    let steps = 0;
    while (y < limit() && steps < 400) {
      y = Math.min(y + step, limit());
      scrollTo({ top: y, behavior: 'instant' });
      steps++;
      await sleep(120);
    }
    scrollTo({ top: 0, behavior: 'instant' });
    return { steps, scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
  });
  await page.waitForTimeout(600);
  return { ...result, ms: Date.now() - started };
}

// {"scroll": "<selector>"}: scroll the first matching element into view (centred), then wait 600 ms.
async function scrollIntoView(page, selector) {
  await page.locator(selector).first().evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForTimeout(600);
}

// Chromium repeats the top of the page in any capture taller than the GPU's max texture size
// (8192 px under SwiftShader), so taller full-page shots are taken in slices and stacked.
const MAX_CAPTURE_PX = 8000;

async function fullPageScreenshot(page, file) {
  // Same page size Playwright uses for fullPage.
  const size = await page.evaluate(() => {
    const b = document.body || document.documentElement;
    const d = document.documentElement;
    return {
      width: Math.max(b.scrollWidth, d.scrollWidth, b.offsetWidth, d.offsetWidth, b.clientWidth, d.clientWidth),
      height: Math.max(b.scrollHeight, d.scrollHeight, b.offsetHeight, d.offsetHeight, b.clientHeight, d.clientHeight),
      dpr: devicePixelRatio,
    };
  });
  if (size.height * size.dpr <= MAX_CAPTURE_PX) {
    await page.screenshot({ path: file, fullPage: true });
    return { slices: 1 };
  }
  let step = Math.floor(MAX_CAPTURE_PX / size.dpr);
  while (step > 1 && !Number.isInteger(step * size.dpr)) step--; // slices meet on whole device pixels
  const slices = [];
  for (let y = 0; y < size.height; y += step) {
    slices.push(await page.screenshot({ fullPage: true, clip: { x: 0, y, width: size.width, height: Math.min(step, size.height - y) } }));
  }
  fs.writeFileSync(file, stackPngs(slices));
  return { slices: slices.length };
}

// Minimal PNG codec for stacking same-width 8-bit RGB/RGBA screenshots (what Chromium writes).
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let header;
  const idat = [];
  for (let pos = 8; pos < buf.length;) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  const bpp = header && { 2: 3, 6: 4 }[header.colorType];
  if (!bpp || header.depth !== 8 || header.interlace) throw new Error(`unsupported PNG layout ${JSON.stringify(header)}`);
  const stride = header.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = up[x];
      if (filter === 0) out[x] = line[x];
      else if (filter === 1) out[x] = line[x] + a;
      else if (filter === 2) out[x] = line[x] + b;
      else if (filter === 3) out[x] = line[x] + ((a + b) >> 1);
      else if (filter === 4) {
        const c = x >= bpp ? up[x - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out[x] = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad PNG filter ${filter}`);
    }
  }
  return { ...header, bpp, pixels };
}

function stackPngs(buffers) {
  const images = buffers.map(decodePng);
  const { width, colorType, bpp } = images[0];
  if (images.some(img => img.width !== width || img.colorType !== colorType)) throw new Error('slices differ in width or colour type');
  const pixels = Buffer.concat(images.map(img => img.pixels));
  const stride = width * bpp;
  const height = pixels.length / stride;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { // "Up" filter: screenshots repeat a lot vertically
    const row = y * (stride + 1);
    raw[row] = y > 0 ? 2 : 0;
    for (let x = 0; x < stride; x++) raw[row + 1 + x] = pixels[y * stride + x] - (y > 0 ? pixels[(y - 1) * stride + x] : 0);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13); // compression, filter method and interlace stay 0
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// What the page actually saw: size, DPR, the emulated media features, and sideways overflow.
async function pageEnv(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const mq = q => matchMedia(q).matches;
    return {
      title: document.title,
      innerWidth, innerHeight, devicePixelRatio,
      scrollWidth: doc.scrollWidth,
      scrollHeight: doc.scrollHeight,
      horizontalOverflow: doc.scrollWidth > doc.clientWidth,
      prefersDark: mq('(prefers-color-scheme: dark)'),
      prefersReducedMotion: mq('(prefers-reduced-motion: reduce)'),
      pointerCoarse: mq('(pointer: coarse)'),
      hoverNone: mq('(hover: none)'),
    };
  }).catch(err => ({ error: err.message }));
}

const realFailures = record => record.failedRequests.filter(f => !f.benign);

function hasProblems(record) {
  return record.problems.length + record.pageErrors.length + record.consoleErrors.length
    + realFailures(record).length + record.httpErrors.length > 0;
}

function firstProblem(record) {
  const failed = realFailures(record)[0];
  const http = record.httpErrors[0];
  const consoleError = record.consoleErrors[0];
  return record.problems[0]
    || (record.pageErrors[0] && `pageerror: ${record.pageErrors[0].message}`)
    || (consoleError && `console: ${consoleError.text}${consoleError.at ? ` @ ${consoleError.at}` : ''}`)
    || (failed && `failed: ${failed.error} ${failed.url}`)
    || (http && `http ${http.status}: ${http.url}`)
    || '';
}

const clip = (text, n = 180) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
};

function counts(record) {
  return `console ${record.consoleErrors.length}, pageerror ${record.pageErrors.length}, `
    + `failed ${realFailures(record).length}, http>=400 ${record.httpErrors.length}`;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

module.exports = {
  API_ORIGIN, MOCK_API, VIEWPORTS, WEBGL_ARGS,
  fail, parseCli, slug, launch, probe, printProbe, newContext, newRecord,
  installMockApi, watchPage, settle, scrollThrough, scrollIntoView, fullPageScreenshot, stackPngs, decodePng, pageEnv,
  hasProblems, firstProblem, counts, clip, writeJson, startServer,
};
