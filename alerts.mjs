import nodemailer from 'nodemailer';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const smtpDefaults = { enabled: false, host: '', port: 587, security: 'starttls', username: '', from: '', to: '', failures: 2, recovery: true };
export function publicSmtp(smtp = {}) { return { ...Object.fromEntries(Object.keys(smtpDefaults).map(key => [key, smtp[key] ?? smtpDefaults[key]])), hasPassword: !!smtp.encryptedPassword }; }
export function recipients(value) {
  const addresses = String(value || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  if (!addresses.length || addresses.length > 20 || addresses.some(x => x.length > 254 || !/^[^\s<>@]+@[^\s<>@]+$/.test(x))) throw new Error('Enter valid email addresses, separated by commas (maximum 20).');
  return [...new Set(addresses)];
}
export class Alerts {
  constructor(history, dir, getConfig) { this.db = history.db; this.dir = dir; this.getConfig = getConfig; this.busy = false; }
  key() {
    const file = path.join(this.dir, 'smtp.key');
    try { return readFileSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; const key = randomBytes(32); writeFileSync(file, key, { mode: 0o600, flag: 'wx' }); return key; }
  }
  encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.'); }
  decrypt(text) { if (!text) return ''; const [iv, tag, data] = text.split('.').map(x => Buffer.from(x, 'base64')); const cipher = createDecipheriv('aes-256-gcm', this.key(), iv); cipher.setAuthTag(tag); return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'); }
  validate(input, old = {}) {
    const smtp = { ...smtpDefaults, ...old };
    for (const field of ['host', 'username', 'from', 'to']) {
      if (typeof input[field] !== 'string' || input[field].length > (field === 'to' ? 4000 : 254) || /[\r\n]/.test(input[field])) throw new Error(`Invalid SMTP ${field}.`);
      smtp[field] = input[field].trim();
    }
    if (smtp.host && !/^[a-zA-Z0-9.:[\]_-]+$/.test(smtp.host)) throw new Error('SMTP host must be a hostname or IP address, without a URL scheme.');
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('SMTP port must be 1–65535.');
    if (!['starttls', 'tls', 'plain'].includes(input.security)) throw new Error('Choose a valid SMTP security mode.');
    if (!Number.isInteger(input.failures) || input.failures < 1 || input.failures > 10) throw new Error('Alert threshold must be 1–10 failed checks.');
    if (typeof input.enabled !== 'boolean' || typeof input.recovery !== 'boolean') throw new Error('Invalid alert options.');
    Object.assign(smtp, { port: input.port, security: input.security, failures: input.failures, enabled: input.enabled, recovery: input.recovery });
    if (input.clearPassword) delete smtp.encryptedPassword;
    if (input.password) { if (typeof input.password !== 'string' || input.password.length > 1024) throw new Error('Invalid SMTP password.'); smtp.encryptedPassword = this.encrypt(input.password); }
    if (smtp.enabled) this.requireComplete(smtp);
    return smtp;
  }
  requireComplete(smtp) {
    if (!smtp.host) throw new Error('Enter an SMTP relay host.');
    if (recipients(smtp.from).length !== 1) throw new Error('Enter one sender address.');
    recipients(smtp.to);
    if (smtp.encryptedPassword && !smtp.username) throw new Error('Enter an SMTP username or clear the saved password.');
  }
  transport(smtp) {
    this.requireComplete(smtp);
    return nodemailer.createTransport({ host: smtp.host.replace(/^\[|\]$/g, ''), port: smtp.port, secure: smtp.security === 'tls', requireTLS: smtp.security === 'starttls', ignoreTLS: smtp.security === 'plain', auth: smtp.username ? { user: smtp.username, pass: this.decrypt(smtp.encryptedPassword) } : undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, disableFileAccess: true, disableUrlAccess: true });
  }
  async send(smtp, subject, text, to = recipients(smtp.to)) {
    const transport = this.transport(smtp);
    try { return await transport.sendMail({ from: smtp.from, to, subject, text, disableFileAccess: true, disableUrlAccess: true }); } finally { transport.close(); }
  }
  safeError(e) { return `Relay delivery failed (${['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EENVELOPE', 'EMESSAGE'].includes(e.code) ? e.code : 'SMTP error'}). Check relay settings, access and TLS.`; }
  observe(site, result) {
    const smtp = this.getConfig().smtp || smtpDefaults;
    const before = this.db.prepare('SELECT * FROM incidents WHERE site=?').get(site.id) || { failures: 0, phase: 'up', since: null };
    let { failures, phase, since } = before;
    let event = null;
    if (result.state === 'down') {
      failures++; since ??= Date.parse(result.checkedAt);
      if (failures >= smtp.failures && phase !== 'down') { phase = 'down'; event = 'DOWN'; }
    } else { if (phase === 'down' && smtp.recovery) event = 'RECOVERED'; phase = 'up'; failures = 0; }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR REPLACE INTO incidents VALUES (?,?,?,?)').run(site.id, failures, phase, result.state === 'up' ? null : since);
      if (event && smtp.enabled) {
        const text = `${site.name} is ${event === 'DOWN' ? 'offline' : 'back online'}.\nWebsite: ${site.url}\nChecked: ${result.checkedAt}\nResult: ${result.detail}\nFirst failed check: ${new Date(since).toISOString()}\n${event === 'RECOVERED' ? 'Observed incident duration: ' + Math.round((Date.parse(result.checkedAt) - since) / 1000) + ' seconds\n' : ''}\nSent by Harbor. Monitoring gaps are not measured downtime.`;
        this.db.prepare('INSERT INTO mail_queue(site,created,subject,body,nextAt) VALUES (?,?,?,?,?)').run(site.id, Date.now(), `[Harbor] ${event}: ${site.name}`, text, Date.now());
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  status() {
    const counts = this.db.prepare("SELECT status, COUNT(*) AS count FROM mail_queue GROUP BY status").all();
    const latest = this.db.prepare('SELECT created,status,error FROM mail_queue ORDER BY id DESC LIMIT 1').get() || null;
    return { pending: counts.find(x => x.status === 'pending')?.count || 0, failed: counts.find(x => x.status === 'failed')?.count || 0, latest };
  }
  async flush() {
    if (this.busy || !this.getConfig().smtp?.enabled) return;
    this.busy = true;
    try {
      const smtp = this.getConfig().smtp;
      const job = this.db.prepare("SELECT * FROM mail_queue WHERE status='pending' AND nextAt<=? ORDER BY id LIMIT 1").get(Date.now());
      if (!job) return;
      let remaining, error;
      try {
        const to = job.recipients ? JSON.parse(job.recipients) : recipients(smtp.to);
        const result = await this.send(smtp, job.subject, job.body, to);
        remaining = to.filter(address => !result.accepted.map(String).includes(address));
        if (remaining.length) error = 'Relay rejected one or more recipients.';
      } catch (e) { error = this.safeError(e); }
      const attempts = job.attempts + 1;
      this.db.prepare('UPDATE mail_queue SET status=?,attempts=?,nextAt=?,error=?,recipients=? WHERE id=?').run(error ? attempts >= 5 ? 'failed' : 'pending' : 'sent', attempts, Date.now() + 60000 * 2 ** (attempts - 1), error || null, remaining?.length ? JSON.stringify(remaining) : job.recipients, job.id);
    } finally { this.busy = false; }
  }
  cancelPending() { this.db.prepare("UPDATE mail_queue SET status='cancelled' WHERE status='pending'").run(); }
}
