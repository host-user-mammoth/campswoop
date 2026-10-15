#!/usr/bin/env node
'use strict';
/*
 * Tiny static file server for QA renders. No dependencies.
 *
 * CLI:     node serve.js --root <folder> [--port 8080] [--host 127.0.0.1] [--quiet]
 *          --port 0 picks a free port; the URL is printed on start. Ctrl+C stops it.
 * Module:  const { startServer } = require('./serve');
 *          const server = await startServer({ root, port: 0 });   // server.url, server.port
 *          await server.close();
 *
 * Responses are Cache-Control: no-store, so a re-shoot always sees fresh files.
 * Any file honours a single "Range: bytes=..." request (206 / 416), which <video> needs for mp4.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { parseArgs } = require('node:util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.pdf': 'application/pdf',
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// One "bytes=" range. Returns null to send the whole file (no usable header, other units, or several
// ranges, which RFC 9110 lets a server ignore), 'unsatisfiable' for a 416, or { start, end } (inclusive).
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {                                   // bytes=-N: the last N bytes
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return null; // malformed: ignore the header
  if (start >= size) return 'unsatisfiable';
  return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

function createHandler(root, { log } = {}) {
  const base = path.resolve(root);
  return async (req, res) => {
    const send = (status, headers, body) => {
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
      if (log) log(`${status} ${req.method} ${req.url}`);
    };
    const text = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ...text, Allow: 'GET, HEAD' }, 'Method not allowed\n');

    let url, pathname;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(400, text, 'Bad request\n');
    }
    let file = path.resolve(base, '.' + pathname);
    if (pathname.includes('\0') || (file !== base && !file.startsWith(base + path.sep))) return send(403, text, 'Forbidden\n');

    let stat;
    try {
      stat = await fs.promises.stat(file);
      if (stat.isDirectory()) {
        if (!url.pathname.endsWith('/')) return send(301, { Location: url.pathname + '/' + url.search }, '');
        file = path.join(file, 'index.html');
        stat = await fs.promises.stat(file);
      }
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      return send(404, text, `Not found: ${pathname}\n`);
    }

    const size = stat.size;
    const headers = { 'Content-Type': contentType(file), 'Accept-Ranges': 'bytes' };
    const range = req.headers.range ? parseRange(req.headers.range, size) : null;
    if (range === 'unsatisfiable') return send(416, { ...headers, 'Content-Range': `bytes */${size}` }, '');
    const { start, end } = range || { start: 0, end: size - 1 };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
    res.writeHead(range ? 206 : 200, { 'Cache-Control': 'no-store', ...headers });
    if (log) log(`${range ? 206 : 200} ${req.method} ${req.url}${range ? ` (bytes ${start}-${end}/${size})` : ''}`);
    if (req.method === 'HEAD' || size === 0) return res.end();
    // Browsers cancel media requests mid-file all the time; pipeline tidies up both streams.
    pipeline(fs.createReadStream(file, { start, end }), res, () => {});
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function startServer({ root, port = 0, host = '127.0.0.1', log } = {}) {
  if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`root folder not found: ${root}`);
  const handler = createHandler(root, { log });
  const servers = [await listen(http.createServer(handler), port, host)];
  const actualPort = servers[0].address().port;
  // Also answer on the IPv6 loopback, so http://localhost works whichever address the client tries first.
  // Loopback-only binds also avoid the Windows firewall prompt that 0.0.0.0 triggers.
  if (host === '127.0.0.1') {
    try {
      servers.push(await listen(http.createServer(handler), actualPort, '::1'));
    } catch { /* no IPv6, or that port is taken on ::1: IPv4 alone is fine */ }
  }
  const loopback = ['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::'].includes(host);
  const urlHost = loopback ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return {
    port: actualPort,
    url: `http://${urlHost}:${actualPort}/`,
    root: path.resolve(root),
    close: () => Promise.all(servers.map(s => new Promise(resolve => {
      s.close(() => resolve());
      s.closeAllConnections();
    }))),
  };
}

const USAGE = `Usage: node serve.js --root <folder> [--port 8080] [--host 127.0.0.1] [--quiet]
  --port 0 picks a free port. The root can also be given as the first argument.`;

if (require.main === module) {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        root: { type: 'string' },
        port: { type: 'string', default: '8080' },
        host: { type: 'string', default: '127.0.0.1' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  const root = values.root || positionals[0];
  const port = Number(values.port);
  if (values.help) { console.log(USAGE); process.exit(0); }
  if (!root || !Number.isInteger(port) || port < 0 || port > 65535) { console.error(USAGE); process.exit(2); }
  startServer({ root, port, host: values.host, log: values.quiet ? null : line => console.log(line) })
    .then(server => {
      console.log(`Serving ${server.root} at ${server.url}  (Ctrl+C to stop)`);
      const stop = () => server.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch(err => {
      console.error(`serve.js: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { startServer, createHandler, parseRange, MIME };
