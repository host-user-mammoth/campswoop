#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const USAGE = `Usage: node shoot.js --root <folder> --out <dir> [options]

Serves <folder> on a free localhost port and screenshots index.html in headless Chromium
(software WebGL) for every hash x viewport x color scheme.

  --hash <h>[,<h2>]      open index.html#<h> (e.g. watch, map). Default: no hash ("nohash" in file names)
  --viewports <list>     desktop (1440x900), mobile (390x844 @2x, touch), or WxH[@scale]. Default: desktop,mobile
  --schemes <list>       light, dark. Default: light,dark
  --reduced-motion       emulate prefers-reduced-motion: reduce
  --full-page            also save <file>-full.png of the whole scrollable page (pages over ~8000 device px
                         are captured in slices and stacked, since Chromium tiles taller captures)
  --wait-for <selector>  after load, wait until this CSS selector is visible (logged if it never is)
  --wait-ms <N>          then wait N more milliseconds (animations, video, WebGL warm-up)
  --scroll               then scroll top to bottom in steps of 80% of the viewport height (120 ms pauses),
                         back to the top, and wait 600 ms, so sections that fade in on scroll
                         (IntersectionObserver) are shown; both the viewport and --full-page shots follow it
  --mock-api             answer https://api.campswoop.com/** locally (POST /signup, POST /requested)
  --name <prefix>        file name prefix. Default: shot
  --channel <name>       omit for Playwright's headless Chromium; or chromium (new headless), chrome, msedge
  --timeout <ms>         limit for --wait-for. Default: 15000

Writes <out>/<name>-<hash>-<viewport>-<scheme>.png (+ -full.png) and <out>/<name>-log.json
with console errors, page errors, failed requests and HTTP errors per shot.
Exit code: 0 when every screenshot was saved (even with page errors; see the log), 1 otherwise, 2 for bad flags.`;

async function shootOne(browser, server, opts, hash, vp, scheme) {
  const base = [opts.name, lib.slug(hash) || 'nohash', vp.name, scheme].join('-');
  const url = `${server.url}index.html${hash ? `#${hash}` : ''}`;
  const record = lib.newRecord({ file: `${base}.png`, saved: false, url, hash, viewport: vp.name, scheme });
  const context = await lib.newContext(browser, opts, vp, scheme);
  if (opts.mockApi) await lib.installMockApi(context, record);
  const page = await context.newPage();
  const stopWatching = lib.watchPage(page, record);
  const started = Date.now();
  try {
    try {
      await page.goto(url, { waitUntil: 'load' });
      record.loadMs = Date.now() - started;
      await lib.settle(page, opts, record);
    } catch (err) {
      record.problems.push(`page did not finish loading: ${err.message.split('\n')[0]}`);
    }
    if (opts.scroll) {
      try {
        record.scroll = await lib.scrollThrough(page);
      } catch (err) {
        record.problems.push(`scroll sweep failed: ${err.message.split('\n')[0]}`);
      }
    }
    record.env = await lib.pageEnv(page);
    await page.screenshot({ path: path.join(opts.out, record.file) });
    record.saved = true;
    if (opts.fullPage) {
      record.fullPageFile = `${base}-full.png`;
      const { slices } = await lib.fullPageScreenshot(page, path.join(opts.out, record.fullPageFile));
      if (slices > 1) record.fullPageSlices = slices;
    }
  } catch (err) {
    record.problems.push(`screenshot failed: ${err.message.split('\n')[0]}`);
  } finally {
    record.totalMs = Date.now() - started;
    stopWatching();
    await context.close().catch(() => {});
  }
  return record;
}

function summary(record, vp) {
  const status = !record.saved ? 'FAIL' : lib.hasProblems(record) ? 'WARN' : 'OK  ';
  const size = `${vp.viewport.width}x${vp.viewport.height}@${vp.deviceScaleFactor}x`;
  const overflow = record.env && record.env.horizontalOverflow ? `  SIDEWAYS SCROLL (${record.env.scrollWidth}px wide)` : '';
  const first = lib.firstProblem(record);
  return `${status} ${record.file.padEnd(36)} ${size.padEnd(14)} ${String(record.totalMs).padStart(5)} ms  `
    + `${lib.counts(record)}${overflow}${first ? `  | ${lib.clip(first)}` : ''}`;
}

async function main() {
  const opts = lib.parseCli(USAGE, {
    extraOptions: { 'full-page': { type: 'boolean', default: false }, scroll: { type: 'boolean', default: false } },
    defaults: { viewports: ['desktop', 'mobile'], schemes: ['light', 'dark'], name: 'shot' },
  });
  opts.fullPage = opts.values['full-page'];
  opts.scroll = opts.values.scroll;
  fs.mkdirSync(opts.out, { recursive: true });
  const logFile = path.join(opts.out, `${opts.name}-log.json`);
  const log = {
    tool: 'shoot.js',
    startedAt: new Date().toISOString(),
    root: opts.root,
    out: opts.out,
    options: {
      hashes: opts.hashes, viewports: opts.viewports.map(v => v.name), schemes: opts.schemes,
      reducedMotion: opts.reducedMotion, fullPage: opts.fullPage, waitFor: opts.waitFor, waitMs: opts.waitMs,
      scroll: opts.scroll, mockApi: opts.mockApi, channel: opts.channel || null,
    },
    shots: [],
  };

  const server = await lib.startServer({ root: opts.root, port: 0 });
  let browser;
  let exitCode = 0;
  try {
    console.log(`Serving ${opts.root} at ${server.url}`);
    browser = await lib.launch(opts.channel, { mockApi: opts.mockApi });
    const probe = await lib.probe(browser, opts.channel);
    Object.assign(log, { browser: probe.browser, webgl: probe.webgl, media: probe.media });
    lib.printProbe(probe);
    for (const hash of opts.hashes) {
      for (const vp of opts.viewports) {
        for (const scheme of opts.schemes) {
          const record = await shootOne(browser, server, opts, hash, vp, scheme);
          log.shots.push(record);
          console.log(summary(record, vp));
          if (!record.saved) exitCode = 1;
        }
      }
    }
  } catch (err) {
    log.fatal = err.stack || String(err);
    console.error(`shoot.js: ${err.message}`);
    exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close();
    log.finishedAt = new Date().toISOString();
    lib.writeJson(logFile, log);
  }
  const warned = log.shots.filter(s => s.saved && lib.hasProblems(s)).length;
  console.log(`${log.shots.filter(s => s.saved).length}/${log.shots.length} screenshots saved to ${opts.out}`
    + `${warned ? ` (${warned} with errors)` : ''}. Log: ${logFile}`);
  process.exitCode = exitCode;
}

main().catch(err => {
  console.error(`shoot.js: ${err.stack || err}`);
  process.exitCode = 1;
});
