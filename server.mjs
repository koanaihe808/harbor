import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'config.json');
let config;
try { config = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; config = { interval: 60, sites: [] }; }
const results = new Map();
let running = null, timer;
const password = process.env.DASHBOARD_PASSWORD;
const host = process.env.HOST || '127.0.0.1';
if (!password && host !== '127.0.0.1' && host !== 'localhost') throw new Error('Set DASHBOARD_PASSWORD before listening beyond localhost.');
function save(next) {
  writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(file + '.tmp', file);
  config = next;
}
function url(value, required = true) {
  if (!value && !required) return '';
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid HTTP or HTTPS URL.');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use HTTP or HTTPS URLs without embedded credentials.');
  return parsed.href;
}
function site(input) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('Site name must be between 1 and 80 characters.');
  const expected = input.expected || '200-399';
  if (!['200-399', '200-399,401,403'].includes(expected)) throw new Error('Invalid expected status selection.');
  return { name: input.name.trim(), url: url(input.url), loginUrl: url(input.loginUrl, false), healthUrl: url(input.healthUrl, false), expected };
}
async function check(s) {
  const start = performance.now();
  let result;
  try {
    const response = await fetch(s.healthUrl || s.url, { signal: AbortSignal.timeout(8000), redirect: 'follow', headers: { 'User-Agent': 'Harbor-Health/1.0' } });
    const latency = Math.round(performance.now() - start);
    await response.body?.cancel();
    const ok = response.status >= 200 && response.status < 400 || s.expected === '200-399,401,403' && [401, 403].includes(response.status);
    result = { state: ok ? 'up' : 'down', latency, code: response.status, detail: `HTTP ${response.status}` };
  } catch (e) {
    result = { state: 'down', latency: null, code: null, detail: e.name === 'TimeoutError' ? 'Timed out after 8 seconds' : 'Connection, DNS, or TLS error' };
  }
  // Do not publish an old result after a site was edited or removed.
  if (config.sites.includes(s)) results.set(s.id, { ...result, checkedAt: new Date().toISOString() });
}
function schedule() { clearTimeout(timer); timer = setTimeout(() => runChecks(), config.interval * 1000); }
function runChecks() {
  if (running) return running;
  clearTimeout(timer);
  const queue = [...config.sites];
  running = Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => { while (queue.length) await check(queue.shift()); }))
    .finally(() => { running = null; schedule(); });
  return running;
}
function authorized(req) {
  if (!password) return true;
  const expected = Buffer.from('Basic ' + Buffer.from(`admin:${password}`).toString('base64'));
  const supplied = Buffer.from(req.headers.authorization || '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON content type required.');
  let chunks = [], size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('Request too large.'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required.');
  return value;
}
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (!password && !['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) return send(403, { error: 'Local preview requires a localhost address.' });
  if (!authorized(req)) { res.setHeader('WWW-Authenticate', 'Basic realm="Harbor", charset="UTF-8"'); return send(401, { error: 'Sign in with your dashboard account.' }); }
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site requests are blocked.' });
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, { error: 'Origin mismatch.' });
    }
    if (pathname === '/api/state' && req.method === 'GET') return send(200, { interval: config.interval, checking: !!running, sites: config.sites.map(s => ({ ...s, status: results.get(s.id) || { state: 'unknown', checkedAt: null, latency: null, detail: 'Waiting for first check' } })) });
    if (pathname === '/api/check' && req.method === 'POST') { await body(req); void runChecks(); return send(202, { ok: true }); }
    if (pathname === '/api/settings' && req.method === 'PUT') {
      const { interval } = await body(req);
      if (!Number.isInteger(interval) || interval < 15 || interval > 3600) throw new Error('Polling interval must be 15–3600 seconds.');
      save({ ...config, interval }); schedule(); return send(200, { ok: true });
    }
    if (pathname === '/api/sites' && req.method === 'POST') {
      if (config.sites.length >= 100) throw new Error('Maximum of 100 sites.');
      const s = { ...site(await body(req)), id: randomUUID() };
      save({ ...config, sites: [...config.sites, s] }); void runChecks(); return send(201, { id: s.id });
    }
    if (pathname.startsWith('/api/sites/') && ['PUT', 'DELETE'].includes(req.method)) {
      const id = pathname.split('/').pop();
      if (!config.sites.some(s => s.id === id)) return send(404, { error: 'Site not found.' });
      const input = await body(req);
      const sites = req.method === 'DELETE' ? config.sites.filter(s => s.id !== id) : config.sites.map(s => s.id === id ? { ...site(input), id } : s);
      save({ ...config, sites }); results.delete(id); void runChecks(); return send(200, { ok: true });
    }
    if (assets[pathname] && req.method === 'GET') {
      const [name, type] = assets[pathname]; res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); return res.end(readFileSync(path.join(root, 'public', name)));
    }
    send(404, { error: 'Not found.' });
  } catch (e) { send(400, { error: e instanceof TypeError ? 'Enter valid HTTP or HTTPS URLs.' : e.message }); }
});
server.requestTimeout = 15000;
server.listen(Number(process.env.PORT || 8080), host, () => { console.log(`Harbor running at http://${host}:${process.env.PORT || 8080}`); void runChecks(); });
