import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { History, DAY, WINDOW, BLOCK } from '../history.mjs';
import { Alerts, smtpDefaults, publicSmtp } from '../alerts.mjs';

function result(state, at = Date.now()) { return { state, latency: state === 'up' ? 20 : null, code: state === 'up' ? 200 : 503, detail: state === 'up' ? 'HTTP 200' : 'HTTP 503', checkedAt: new Date(at).toISOString() }; }
test('durable history, mixed failure bars, unknown gaps, retention and deletion', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harbor-history-')), file = path.join(dir, 'history.sqlite');
  let history = new History(file);
  try {
    const now = Math.floor(Date.now() / BLOCK) * BLOCK + 10000;
    history.record('one', result('up', now - 1000)); history.record('one', result('down', now - 2000));
    history.record('one', result('up', now - 184 * DAY)); history.record('one', result('down', now - 186 * DAY));
    history.record('one', result('up', now - 2 * DAY));
    history.prune(185, now);
    assert.equal(history.db.prepare('SELECT COUNT(*) AS n FROM buckets').get().n, 3);
    const timeline = history.timeline('one', now);
    assert.equal(timeline.bins.length, 24); assert.equal(timeline.bins.at(-1).state, 'mixed'); assert.equal(timeline.bins[0].state, 'unknown'); assert.equal(timeline.uptime, 50); assert.equal(timeline.failed, 1);
    assert.equal(history.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n, 2);
    assert.equal(history.summary('one', 185, now).checks, 4);
    history.close(); history = new History(file);
    assert.equal(history.summary('one', 185, now).failed, 1);
    assert.equal(history.latest('one').state, 'up');
    history.prune(1, now); assert.equal(history.summary('one', 185, now).checks, 2);
    assert.equal(history.timeline('one', now + WINDOW + 1).checks, 0);
    history.remove('one'); assert.equal(history.latest('one'), null); assert.equal(history.summary('one', 185, now).checks, 0);
  } finally { history.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('SMTP relay delivery, secrets, incident deduplication across restarts and retries', { timeout: 15000 }, async t => {
  const messages = [], sockets = new Set(); let reject = false;
  const relay = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); socket.write('220 test-relay ESMTP\r\n');
    let buffer = '', data = false, message = [];
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const at = buffer.indexOf('\r\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        if (data) { if (line === '.') { data = false; messages.push(message.join('\n')); message = []; socket.write('250 Accepted\r\n'); } else message.push(line); continue; }
        if (/^(EHLO|HELO)/.test(line)) socket.write('250-test-relay\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/.test(line)) socket.write('235 Authenticated\r\n');
        else if (/^MAIL/.test(line)) socket.write(reject ? '550 Sender rejected\r\n' : '250 OK\r\n');
        else if (/^RCPT/.test(line)) socket.write('250 OK\r\n');
        else if (/^DATA/.test(line)) { data = true; socket.write('354 End with dot\r\n'); }
        else if (/^QUIT/.test(line)) socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const dir = mkdtempSync(path.join(tmpdir(), 'harbor-mail-')), file = path.join(dir, 'history.sqlite');
  let history = new History(file), config = { smtp: { ...smtpDefaults } }, alerts = new Alerts(history, dir, () => config);
  t.after(() => { for (const s of sockets) s.destroy(); relay.close(); history.close(); rmSync(dir, { recursive: true, force: true }); });
  config.smtp = alerts.validate({ ...smtpDefaults, host: '127.0.0.1', port: relay.address().port, security: 'plain', from: 'harbor@example.test', to: 'admin@example.test', enabled: true, username: 'relay-user', password: 'secret-for-test-only' });
  const safe = publicSmtp(config.smtp);
  assert.equal(safe.hasPassword, true); assert.ok(!JSON.stringify(safe).includes('secret')); assert.ok(!('encryptedPassword' in safe));
  assert.ok(!JSON.stringify(config.smtp).includes('secret-for-test-only'));
  assert.equal(readFileSync(path.join(dir, 'smtp.key')).length, 32);
  assert.equal(alerts.decrypt(config.smtp.encryptedPassword), 'secret-for-test-only');
  const kept = alerts.validate({ ...safe, password: '' }, config.smtp); assert.equal(kept.encryptedPassword, config.smtp.encryptedPassword);
  const cleared = alerts.validate({ ...safe, password: '', clearPassword: true }, config.smtp); assert.equal(cleared.encryptedPassword, undefined);
  assert.throws(() => alerts.validate({ ...safe, port: 0 }), /port/);
  assert.throws(() => alerts.validate({ ...safe, security: 'unsafe' }), /security/);
  assert.throws(() => alerts.validate({ ...safe, from: 'one@example.test\r\nBcc: two@example.test' }), /Invalid/);
  assert.equal(alerts.transport({ ...config.smtp, security: 'starttls' }).options.requireTLS, true);
  assert.equal(alerts.transport({ ...config.smtp, security: 'tls' }).options.secure, true);
  const site = { id: 'one', name: 'Test service', url: 'http://example.test' };
  alerts.observe(site, result('down')); await alerts.flush(); assert.equal(messages.length, 0);
  alerts.observe(site, result('down')); await alerts.flush(); assert.equal(messages.length, 1); assert.match(messages[0], /DOWN: Test service/);
  alerts.observe(site, result('down')); await alerts.flush(); assert.equal(messages.length, 1);
  history.close(); history = new History(file); alerts = new Alerts(history, dir, () => config);
  alerts.observe(site, result('down')); await alerts.flush(); assert.equal(messages.length, 1);
  alerts.observe(site, result('up')); await alerts.flush(); assert.equal(messages.length, 2); assert.match(messages[1], /RECOVERED: Test service/);
  alerts.observe(site, result('up')); await alerts.flush(); assert.equal(messages.length, 2);
  reject = true; alerts.observe(site, result('down')); alerts.observe(site, result('down')); await alerts.flush(); assert.equal(alerts.status().pending, 1); assert.match(alerts.status().latest.error, /Relay delivery failed/);
  reject = false; history.db.prepare("UPDATE mail_queue SET nextAt=0 WHERE status='pending'").run(); await alerts.flush(); assert.equal(messages.length, 3); assert.equal(alerts.status().pending, 0);
  config.smtp.recovery = false; alerts.observe(site, result('up')); await alerts.flush(); assert.equal(messages.length, 3);
  alerts.observe(site, result('down')); alerts.observe(site, result('down')); alerts.cancelPending(); await alerts.flush(); assert.equal(messages.length, 3);
  reject = true;
  const other = { ...site, id: 'two' }; alerts.observe(other, result('down')); alerts.observe(other, result('down'));
  for (let i = 0; i < 5; i++) { history.db.prepare("UPDATE mail_queue SET nextAt=0 WHERE status='pending'").run(); await alerts.flush(); }
  assert.equal(alerts.status().failed, 1); assert.equal(alerts.status().pending, 0);
  assert.equal(history.db.prepare("SELECT attempts FROM mail_queue WHERE status='failed'").get().attempts, 5);
});
