#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const USAGE = `Usage: node interact.js --root <folder> --out <dir> --steps <steps.json | '<inline JSON>' | -> [options]

Serves <folder>, opens index.html[#hash] in headless Chromium (software WebGL) and runs the steps
in a fresh page for every viewport x scheme. Stops a run at the first failing step and saves
<name>-error-step<N>-<viewport>-<scheme>.png.

Steps: a JSON array (or {"steps": [...]}) of objects or arrays:
  {"click": "<selector>"}                           ["click", "<selector>"]
  {"fill": "<selector>", "text": "<text>"}          ["fill", "<selector>", "<text>"]
  {"press": "<key>"}  (focused element)            ["press", "Enter"]
  {"press": "<key>", "selector": "<selector>"}      ["press", "Tab", "#email"]
  {"wait": <ms>}                                    ["wait", 500]
  {"waitFor": "<selector>"}  ("state": attached|visible|hidden|detached; default visible)
  {"screenshot": "<label>"}  ("fullPage": true)    ["screenshot", "after-submit"]
  {"scroll": "through"}  top to bottom in 80%-viewport steps (120 ms pauses), back to top, wait 600 ms,
                         so sections that fade in on scroll are shown; logs the steps taken and page height
  {"scroll": "<selector>"}  scroll that element into view, then wait 600 ms      ["scroll", "#faq"]
  {"evaluate": "<JS expression>"}  result printed + logged; "() => ..." functions are called
  {"assert": "<JS expression>", "message": "<why>"}  fails the run when falsy
Selectors are Playwright selectors (CSS, or text=..., role=...). Keys: Enter, Tab, Escape, ArrowDown, ...

Options:
  --hash <h>  --viewports <list>  --schemes <list>  --reduced-motion  --wait-for <selector>  --wait-ms <N>
  --name <prefix>  --channel <name>  --timeout <ms>   (as in shoot.js; --timeout is per step, default 15000)
  Defaults: --viewports desktop --schemes light --name interact.
  The CampSwoop API (https://api.campswoop.com) is mocked by default so test sign-ups never reach it;
  --mock-api is accepted for symmetry, and --live-api lets requests through to the real API.

Writes <out>/<name>-<label>-<viewport>-<scheme>.png per screenshot step and <out>/<name>-log.json.
Exit code: 0 when every step passed, 1 when one failed, 2 for bad flags or steps.`;

const STEP_TYPES = ['click', 'fill', 'press', 'wait', 'waitFor', 'screenshot', 'scroll', 'evaluate', 'assert'];
// For the array form: what the third element means for each step type.
const SECOND_FIELD = { fill: 'text', press: 'selector', waitFor: 'state', screenshot: 'fullPage', assert: 'message' };

function normalizeStep(raw, index) {
  let step = raw;
  if (Array.isArray(raw)) {
    const [type, value, extra] = raw;
    step = { [type]: value };
    if (extra !== undefined && SECOND_FIELD[type]) step[SECOND_FIELD[type]] = extra;
  }
  const types = step && typeof step === 'object' ? STEP_TYPES.filter(t => t in step) : [];
  if (types.length !== 1) {
    lib.fail(`Step ${index + 1} needs exactly one of ${STEP_TYPES.join(', ')}; got ${JSON.stringify(raw)}`);
  }
  const type = types[0];
  if (type === 'fill' && typeof step.text !== 'string') lib.fail(`Step ${index + 1}: fill needs "text" (a string).`);
  if (type === 'wait' && !(Number(step.wait) >= 0)) lib.fail(`Step ${index + 1}: wait needs a number of ms.`);
  if (type === 'scroll' && (typeof step.scroll !== 'string' || !step.scroll)) lib.fail(`Step ${index + 1}: scroll needs "through" or a selector.`);
  return { type, ...step };
}

function readSteps(arg) {
  if (!arg) lib.fail(`--steps is required.\n\n${USAGE}`);
  let text;
  try {
    if (arg === '-') text = fs.readFileSync(0, 'utf8');
    else if (/^\s*[[{]/.test(arg)) text = arg;
    else text = fs.readFileSync(path.resolve(arg), 'utf8');
  } catch (err) {
    lib.fail(`Can't read --steps: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    lib.fail(`--steps is not valid JSON: ${err.message}`);
  }
  const steps = Array.isArray(data) ? data : data && data.steps;
  if (!Array.isArray(steps) || !steps.length) lib.fail('--steps must be a non-empty JSON array, or an object with a "steps" array.');
  return steps.map(normalizeStep);
}

// Playwright evaluates a string as an expression; call it when it is written as a function.
// "() => x", "async () => x", "x => x", "function () {}"; not an IIFE like "(() => x)()".
const FUNCTION_SOURCE = /^\s*(async\s+)?(function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
const asExpression = src => (FUNCTION_SOURCE.test(src) ? `(${src})()` : src);

function describe(step) {
  const q = s => JSON.stringify(String(s));
  switch (step.type) {
    case 'fill': return `fill ${step.fill} ${lib.clip(q(step.text), 60)}`;
    case 'press': return `press ${step.press}${step.selector ? ` on ${step.selector}` : ''}`;
    case 'wait': return `wait ${step.wait} ms`;
    case 'waitFor': return `waitFor ${step.waitFor}${step.state ? ` (${step.state})` : ''}`;
    case 'evaluate': return `evaluate ${lib.clip(step.evaluate, 70)}`;
    case 'assert': return `assert ${lib.clip(step.assert, 70)}`;
    default: return `${step.type} ${step[step.type]}`;
  }
}

async function runStep(page, step, shotFile) {
  switch (step.type) {
    case 'click': await page.click(step.click); return {};
    case 'fill': await page.fill(step.fill, step.text); return {};
    case 'press':
      if (step.selector) await page.press(step.selector, step.press);
      else await page.keyboard.press(step.press);
      return {};
    case 'wait': await page.waitForTimeout(Number(step.wait)); return {};
    case 'waitFor': await page.waitForSelector(step.waitFor, { state: step.state || 'visible' }); return {};
    case 'screenshot': {
      const file = shotFile(step.screenshot);
      if (step.fullPage) await lib.fullPageScreenshot(page, file);
      else await page.screenshot({ path: file });
      return { file: path.basename(file) };
    }
    case 'scroll':
      if (step.scroll === 'through') return { value: await lib.scrollThrough(page) };
      await lib.scrollIntoView(page, step.scroll);
      return {};
    case 'evaluate': return { value: await page.evaluate(asExpression(step.evaluate)) };
    case 'assert': {
      const value = await page.evaluate(asExpression(step.assert));
      if (!value) throw new Error(step.message ? `${step.message} (got ${JSON.stringify(value)})` : `assertion was ${JSON.stringify(value)}`);
      return { value };
    }
    default: throw new Error(`unknown step type ${step.type}`);
  }
}

async function runOnce(browser, server, opts, steps, vp, scheme) {
  const url = `${server.url}index.html${opts.hash ? `#${opts.hash}` : ''}`;
  const record = lib.newRecord({ viewport: vp.name, scheme, url, passed: false, steps: [] });
  const shotFile = label => path.join(opts.out, `${[opts.name, lib.slug(label), vp.name, scheme].join('-')}.png`);
  const context = await lib.newContext(browser, opts, vp, scheme);
  if (opts.mockApi) await lib.installMockApi(context, record);
  const page = await context.newPage();
  const stopWatching = lib.watchPage(page, record);
  console.log(`-- ${vp.name} ${scheme}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'load' });
    await lib.settle(page, opts, record);
    for (const [i, step] of steps.entries()) {
      const started = Date.now();
      const entry = { step: i + 1, type: step.type, detail: describe(step) };
      record.steps.push(entry);
      try {
        Object.assign(entry, await runStep(page, step, shotFile), { ok: true, ms: Date.now() - started });
        const shown = entry.file ? `  -> ${entry.file}` : 'value' in entry ? `  -> ${lib.clip(JSON.stringify(entry.value) ?? 'undefined', 160)}` : '';
        console.log(`   [${i + 1}/${steps.length}] ok    ${entry.detail} (${entry.ms} ms)${shown}`);
      } catch (err) {
        Object.assign(entry, { ok: false, ms: Date.now() - started, error: err.message.split('\n')[0] });
        console.log(`   [${i + 1}/${steps.length}] FAIL  ${entry.detail}: ${lib.clip(entry.error, 200)}`);
        const errorShot = shotFile(`error-step${i + 1}`);
        if (await page.screenshot({ path: errorShot }).then(() => true, () => false)) entry.errorScreenshot = path.basename(errorShot);
        return record;
      }
    }
    record.passed = true;
    return record;
  } catch (err) {
    record.problems.push(`page did not load: ${err.message.split('\n')[0]}`);
    return record;
  } finally {
    stopWatching();
    await context.close().catch(() => {});
    const first = lib.firstProblem(record);
    console.log(`   ${record.passed ? 'PASS' : 'FAIL'}  ${lib.counts(record)}, api calls ${record.apiCalls.length}`
      + `${first ? `  | ${lib.clip(first)}` : ''}`);
  }
}

async function main() {
  const opts = lib.parseCli(USAGE, {
    extraOptions: { steps: { type: 'string' }, 'live-api': { type: 'boolean', default: false } },
    defaults: { viewports: ['desktop'], schemes: ['light'], name: 'interact' },
  });
  if (opts.hashes.length > 1) lib.fail('interact.js takes one --hash at a time.');
  if (opts.values['live-api'] && opts.values['mock-api']) lib.fail('Use either --mock-api or --live-api, not both.');
  opts.hash = opts.hashes[0];
  opts.mockApi = !opts.values['live-api'];
  const steps = readSteps(opts.values.steps);
  fs.mkdirSync(opts.out, { recursive: true });
  const logFile = path.join(opts.out, `${opts.name}-log.json`);
  const log = {
    tool: 'interact.js',
    startedAt: new Date().toISOString(),
    root: opts.root,
    out: opts.out,
    options: {
      hash: opts.hash, viewports: opts.viewports.map(v => v.name), schemes: opts.schemes, reducedMotion: opts.reducedMotion,
      waitFor: opts.waitFor, waitMs: opts.waitMs, mockApi: opts.mockApi, channel: opts.channel || null,
    },
    steps,
    runs: [],
  };

  const server = await lib.startServer({ root: opts.root, port: 0 });
  let browser;
  try {
    console.log(`Serving ${opts.root} at ${server.url}${opts.mockApi ? ' (CampSwoop API mocked)' : ' (LIVE CampSwoop API)'}`);
    browser = await lib.launch(opts.channel, { mockApi: opts.mockApi });
    const probe = await lib.probe(browser, opts.channel);
    Object.assign(log, { browser: probe.browser, webgl: probe.webgl, media: probe.media });
    lib.printProbe(probe);
    for (const vp of opts.viewports) {
      for (const scheme of opts.schemes) log.runs.push(await runOnce(browser, server, opts, steps, vp, scheme));
    }
  } catch (err) {
    log.fatal = err.stack || String(err);
    console.error(`interact.js: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close();
    log.finishedAt = new Date().toISOString();
    lib.writeJson(logFile, log);
  }
  const passed = log.runs.filter(r => r.passed).length;
  console.log(`${passed}/${log.runs.length} runs passed. Log: ${logFile}`);
  process.exitCode = !log.fatal && log.runs.length && passed === log.runs.length ? 0 : 1;
}

main().catch(err => {
  console.error(`interact.js: ${err.stack || err}`);
  process.exitCode = 1;
});
