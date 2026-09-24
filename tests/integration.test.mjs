import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('health checks, validation, authentication, CRUD and restart persistence', { timeout: 45000 }, async t => {
  const fixture = http.createServer((req, res) => {
    if (req.url === '/slow') return;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
    res.writeHead(req.url === '/bad' ? 503 : req.url === '/locked' ? 401 : 200); res.end('fixture');
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const target = `http://127.0.0.1:${fixture.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'harbor-test-'));
  let child, base;
  t.after(async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } fixture.closeAllConnections(); fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  async function start() {
    // Reserve an available local port, then release immediately before spawn.
    const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(r => probe.close(r));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dir, DASHBOARD_PASSWORD: 'test-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Server exited before readiness'); })]);
  }
  await start();
  const auth = 'Basic ' + Buffer.from('admin:test-password').toString('base64');
  async function request(route, method = 'GET', data, extra = {}) { return fetch(base + '/api/' + route, { method, headers: { Authorization: auth, 'Content-Type': 'application/json', ...extra }, body: data === undefined ? undefined : JSON.stringify(data) }); }
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await request('state', 'GET', undefined, { Authorization: 'Basic bad' })).status, 401);
  assert.equal((await request('sites', 'POST', { name: 'Bad', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await request('sites', 'POST', { name: 'Bad', url: 'https://user:secret@example.com' })).status, 400);
  assert.equal((await request('settings', 'PUT', { interval: 0 })).status, 400);
  assert.equal((await request('settings', 'PUT', { retentionDays: 186 })).status, 400);
  assert.equal((await request('settings', 'PUT', { retentionDays: 185 })).status, 200);
  const smtpDefaults = await (await request('smtp')).json();
  assert.equal(smtpDefaults.hasPassword, false);
  const smtpResponse = await request('smtp', 'PUT', { ...smtpDefaults, host: '127.0.0.1', username: 'tester', password: 'only-test-secret' });
  assert.equal(smtpResponse.status, 200);
  const smtpPublic = await smtpResponse.json(); assert.equal(smtpPublic.hasPassword, true); assert.ok(!('encryptedPassword' in smtpPublic)); assert.ok(!('password' in smtpPublic));
  assert.ok(!readFileSync(join(dir, 'config.json'), 'utf8').includes('only-test-secret'));
  assert.equal((await request('settings', 'PUT', { interval: 30 }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('settings', 'PUT', { interval: 30 }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('settings', 'PUT', { interval: 30 })).status, 200);
  const cases = [['Healthy', '/ok', 'up'], ['Redirect', '/redirect', 'up'], ['Broken', '/bad', 'down'], ['Protected', '/locked', 'up'], ['Timeout', '/slow', 'down']];
  const ids = [];
  for (const [name, route] of cases) { const r = await request('sites', 'POST', { name, url: target + route, loginUrl: target + '/login', expected: name === 'Protected' ? '200-399,401,403' : '200-399' }); assert.equal(r.status, 201); ids.push((await r.json()).id); }
  async function waitUntil(predicate, timeout = 13000) { const end = Date.now() + timeout; while (Date.now() < end) { const state = await (await request('state')).json(); if (predicate(state)) return state; await new Promise(r => setTimeout(r, 100)); } throw new Error('State did not converge'); }
  await waitUntil(s => !s.checking); await request('check', 'POST', {});
  const state = await waitUntil(s => !s.checking && s.sites.every(x => x.status.checkedAt));
  for (let i = 0; i < cases.length; i++) { assert.equal(state.sites[i].status.state, cases[i][2]); assert.ok(state.sites[i].status.checkedAt); }
  assert.equal(state.retentionDays, 185);
  assert.equal(state.sites[2].timeline.bins.length, 24);
  assert.ok(state.sites[2].timeline.failed > 0);
  const savedHistory = await (await request('history/' + ids[0] + '?days=185')).json(); assert.ok(savedHistory.checks > 0);
  assert.equal((await request('history/' + ids[0] + '?days=186')).status, 400);
  assert.equal(state.sites[4].status.latency, null); assert.match(state.sites[4].status.detail, /Timed out/);
  assert.equal((await request('sites/' + ids[0], 'PUT', { name: 'Renamed', url: target + '/ok', loginUrl: target + '/new-login' })).status, 200);
  assert.equal((await request('sites/' + ids[4], 'DELETE', {})).status, 200);
  const stored = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(stored.sites.length, 4); assert.equal(stored.sites[0].name, 'Renamed'); assert.equal(stored.interval, 30);
  child.kill(); await once(child, 'exit'); await start();
  const restored = await (await request('state')).json(); assert.equal(restored.sites.length, 4); assert.equal(restored.sites[0].loginUrl, target + '/new-login'); assert.equal(restored.interval, 30);
  assert.equal(restored.retentionDays, 185); assert.ok((await (await request('history/' + ids[0])).json()).checks >= savedHistory.checks);
  assert.equal((await (await request('smtp')).json()).hasPassword, true);
});
