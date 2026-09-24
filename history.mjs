import { DatabaseSync } from 'node:sqlite';

export const DAY = 86400000, BLOCK = 300000, WINDOW = 7200000;
export class History {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS samples (site TEXT NOT NULL, at INTEGER NOT NULL, up INTEGER NOT NULL, latency INTEGER);
      CREATE INDEX IF NOT EXISTS idx_samples_site_at ON samples(site,at);
      CREATE INDEX IF NOT EXISTS idx_samples_at ON samples(at);
      CREATE TABLE IF NOT EXISTS buckets (site TEXT NOT NULL, at INTEGER NOT NULL, up INTEGER NOT NULL, down INTEGER NOT NULL, latencySum INTEGER NOT NULL, latencyCount INTEGER NOT NULL, PRIMARY KEY(site,at));
      CREATE INDEX IF NOT EXISTS idx_buckets_at ON buckets(at);
      CREATE TABLE IF NOT EXISTS latest (site TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incidents (site TEXT PRIMARY KEY, failures INTEGER NOT NULL, phase TEXT NOT NULL, since INTEGER);
      CREATE TABLE IF NOT EXISTS mail_queue (id INTEGER PRIMARY KEY, site TEXT, created INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL, error TEXT, recipients TEXT);
      CREATE INDEX IF NOT EXISTS idx_mail_queue_status_next ON mail_queue(status,nextAt);
      PRAGMA optimize;`);
  }
  record(id, result, at = Date.parse(result.checkedAt)) {
    const up = result.state === 'up' ? 1 : 0;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO samples VALUES (?,?,?,?)').run(id, at, up, result.latency);
      this.db.prepare(`INSERT INTO buckets VALUES (?,?,?,?,?,?) ON CONFLICT(site,at) DO UPDATE SET up=up+excluded.up, down=down+excluded.down, latencySum=latencySum+excluded.latencySum, latencyCount=latencyCount+excluded.latencyCount`).run(id, Math.floor(at / BLOCK) * BLOCK, up, 1 - up, result.latency || 0, result.latency === null ? 0 : 1);
      this.db.prepare('INSERT OR REPLACE INTO latest VALUES (?,?)').run(id, JSON.stringify(result));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  latest(id) { const row = this.db.prepare('SELECT result FROM latest WHERE site=?').get(id); return row ? JSON.parse(row.result) : null; }
  timeline(id, now = Date.now()) {
    const from = now - WINDOW;
    const bins = Array.from({ length: 24 }, (_, i) => ({ from: from + i * BLOCK, to: from + (i + 1) * BLOCK, up: 0, down: 0 }));
    const rows = this.db.prepare('SELECT at,up FROM samples WHERE site=? AND at>=? AND at<=? ORDER BY at').all(id, from, now);
    for (const row of rows) { const b = bins[Math.min(23, Math.floor((row.at - from) / BLOCK))]; b[row.up ? 'up' : 'down']++; }
    const up = rows.reduce((n, r) => n + r.up, 0);
    return { from, to: now, checks: rows.length, failed: rows.length - up, uptime: rows.length ? 100 * up / rows.length : null, bins: bins.map(b => ({ ...b, state: b.down ? b.up ? 'mixed' : 'down' : b.up ? 'up' : 'unknown' })) };
  }
  summary(id, days, now = Date.now()) {
    // Five-minute aggregates: the first boundary bucket can be partial.
    const from = Math.floor((now - days * DAY) / BLOCK) * BLOCK;
    const daily = this.db.prepare(`SELECT CAST(at / ? AS INTEGER) * ? AS at, SUM(up) AS up, SUM(down) AS down, SUM(latencySum) AS latencySum, SUM(latencyCount) AS latencyCount FROM buckets WHERE site=? AND at>=? AND at<=? GROUP BY CAST(at / ? AS INTEGER) ORDER BY at DESC`).all(DAY, DAY, id, from, now, DAY);
    const totals = daily.reduce((s, r) => ({ up: s.up + r.up, down: s.down + r.down }), { up: 0, down: 0 });
    const failures = this.db.prepare('SELECT at,up,down FROM buckets WHERE site=? AND at>=? AND at<=? AND down>0 ORDER BY at DESC LIMIT 100').all(id, from, now);
    return { days, from, to: now, checks: totals.up + totals.down, failed: totals.down, uptime: totals.up + totals.down ? 100 * totals.up / (totals.up + totals.down) : null, daily, failures };
  }
  prune(days, now = Date.now()) {
    this.db.prepare('DELETE FROM samples WHERE at<?').run(now - WINDOW);
    this.db.prepare('DELETE FROM buckets WHERE at<?').run(Math.floor((now - days * DAY) / BLOCK) * BLOCK);
    this.db.prepare("DELETE FROM mail_queue WHERE created<? AND status!='pending'").run(now - days * DAY);
    this.db.prepare("UPDATE mail_queue SET status='failed', error='Expired after 24 hours' WHERE status='pending' AND created<?").run(now - DAY);
  }
  remove(id) {
    for (const table of ['samples', 'buckets', 'latest', 'incidents', 'mail_queue']) this.db.prepare(`DELETE FROM ${table} WHERE site=?`).run(id);
  }
  close() { this.db.close(); }
}
