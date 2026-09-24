# Harbor

A lightweight, self-hosted directory for your websites. See online/offline status, response time and the exact last-check time; open a service or its sign-in page; and add, edit or remove websites from the dashboard.

Node.js 24+ with built-in SQLite for history and Nodemailer for SMTP. No build step, external fonts, database server or hosted services. The Sites design workflow was used, but this package runs on your home server rather than cloud hosting so it can reach private addresses.

## New in 1.1: history and email alerts

Open **History & alerts** to choose **1–185 days** of saved history (default: 30) and enter your SMTP relay settings. Your original website configuration is loaded automatically. History begins with checks made by this version; previous monitoring data cannot be reconstructed.

Each website card has a two-hour strip of 24 five-minute blocks, oldest on the left:

- **Green:** all recorded checks passed.
- **Red:** all recorded checks failed.
- **Amber:** both passed and failed checks, so brief failures remain visible.
- **Gray:** no checks in that period, including when Harbor was stopped.

Hover, keyboard-focus or tap a block for its exact time range and check counts. The percentage is **successful checks / recorded checks**, not a time-weighted availability guarantee. Sparse polling leaves gray gaps, and outages between checks cannot be detected. The strip refreshes with each result or at least once per minute. **View saved history** opens daily totals, response-time averages and the latest 100 five-minute periods containing failures for any range within your retention limit. Daily totals use UTC; failed-period times use your browser's local time.

Raw checks are retained for two hours. Five-minute aggregates are retained for the chosen number of days, with a partial boundary bucket (up to five minutes). Aggregates preserve the counts of passed/failed checks and latency totals rather than every individual response. Lowering retention removes older records immediately; increasing it cannot recover records already removed. Deleted websites also lose their history and pending alerts. Edits retain history under the same website entry; create a new entry if you want a fresh history for a different service.

For capacity planning, 185 days at continuous monitoring is at most about 53,280 aggregate rows per website, plus two hours of raw checks and alert records. SQLite disk usage depends on the number of sites and checks; freed pages are reused and the database file does not necessarily shrink when retention is reduced.

### SMTP relay fields

| Field | What to enter |
| --- | --- |
| Enable downtime alerts | Turn on automatic incident notifications after the relay is configured. |
| SMTP relay host | Hostname or IP reachable from the Harbor container; no `smtp://` prefix. |
| Port | Your relay's listening port, commonly 25, 587 or 465. |
| Connection security | STARTTLS required, TLS immediately, or no encryption for a trusted private relay. TLS certificates are validated. |
| Username / password | Optional; leave both blank for an IP-allowed relay without authentication. Blank password preserves a saved password; use Clear saved password to remove it. |
| From email | A single sender address permitted by your relay. |
| Recipient email(s) | Up to 20 comma-separated recipient addresses. |
| Consecutive failures | 1–10 failed checks before one downtime notification; default 2. |
| Notify when recovered | Send one recovery notification when the next successful check ends the incident. |

Click **Save relay settings**, then **Send test email**. A successful response means the relay accepted the message, not proof of inbox delivery. Check your inbox and relay logs. Testing works even with automatic alerts disabled. The app does not need to authenticate to your websites to send alerts.

Incidents and the delivery queue survive restarts. An ongoing outage does not send a new notification every poll or after a restart. Starting with a site already down triggers an incident after the configured number of failed checks. Enabling alerts during an already-detected incident does not backfill its downtime alert; future transitions are notified. Detection depends on polling, and Harbor cannot send notifications while Harbor itself is stopped.

Failed delivery retries up to five attempts with increasing delays of 1, 2, 4 and 8 minutes. Pending messages expire after 24 hours. The dashboard shows pending/failed delivery counts; settings show the latest alert's delivery status. Disabling automatic alerts cancels queued messages, although an in-flight delivery may finish. Pending alerts use the current relay settings. A partial recipient acceptance retries only rejected recipients; an ambiguous network failure or a process crash immediately after relay acceptance can result in a duplicate. Sent/failed/cancelled records follow the history retention limit.

SMTP passwords are encrypted with AES-256-GCM in server-side `config.json`; the encryption key is stored in `data/smtp.key` with restrictive permissions where supported. Neither the saved password nor its ciphertext is returned by the settings API. Protect the data directory and backups: anyone with both the key and configuration can decrypt the password. Losing the key requires re-entering the relay password. Use HTTPS when entering SMTP settings remotely.

Transport behavior follows the [Nodemailer SMTP documentation](https://nodemailer.com/smtp); history uses [Node's built-in SQLite API](https://nodejs.org/api/sqlite.html).

### Upgrade from the first package

Back up the entire data directory using the procedure below. Replace the application files, preserving your `.env` and existing data volume, and run `docker compose up -d --build` from the **same Compose project directory/name** so Docker reuses the existing volume. For a direct Node installation, install Node.js 24+, run `npm ci --omit=dev`, then restart Harbor. Do not replace `data/config.json` with a sample file. The new history database is created automatically. Keep the old package and backup for rollback; rollback to version 1.0 loses the history/alert features but can retain the original sites.

## Docker Compose

1. Extract the ZIP and open a terminal in the `harbor` folder (the one containing `compose.yaml`). Install Docker Engine with the Compose plugin, or Docker Desktop with Linux containers.
2. Copy `.env.example` to `.env`. Set `DASHBOARD_PASSWORD` to a strong, unique password. Leave `BIND_ADDRESS=127.0.0.1` for access only from the host or a reverse proxy on that host. Use single quotes around a password containing `$` or `#` in the `.env` file.
3. Start it:

   ```sh
   docker compose up -d --build
   ```

4. On that machine, open **http://localhost:8080**. Sign in with username **admin** and the dashboard password you chose.
5. Click **Add website**. Enter its name and full `http://` or `https://` address. The optional login URL opens the website's sign-in page. The optional health URL lets you check a lightweight endpoint such as `/health` instead of the homepage.

To reach Harbor from other devices, set `BIND_ADDRESS` to the server's LAN address or `0.0.0.0`, then recreate the container with `docker compose up -d`. Restrict access to your LAN/VPN; use an HTTPS reverse proxy for credential protection. HTTP Basic authentication does not encrypt credentials over plain HTTP. Do not forward the port directly to the internet. A proxy must preserve the original Host header and forward Authorization. A proxy running in another container needs a shared Docker network to reach `harbor:8080`; its localhost is not the Docker host.

The dashboard password is held only in server environment configuration. Harbor stores no site passwords and never sends the dashboard password to monitored websites. There is no password vault, automatic login or shared SSO: **Sign in** opens the configured URL in a new tab, where the website and your password manager handle login. Do not put passwords, tokens or other secrets in URLs.

## Run without Docker

Install Node.js 24 or newer. In the `harbor` folder:

```sh
npm ci --omit=dev
npm start
```

Open **http://127.0.0.1:8080**. By default this binds to loopback and needs no password, suitable for a local preview. For LAN use, set `HOST=0.0.0.0` and `DASHBOARD_PASSWORD` in the process environment before starting; the app refuses an unprotected non-loopback bind. The `.env` file is read by Compose, not by `npm start`. Optional environment settings: `PORT` (8080), `DATA_DIR` (the app's `data` folder).

Linux/macOS example:

```sh
HOST=0.0.0.0 DASHBOARD_PASSWORD='your-unique-password' npm start
```

PowerShell example:

```powershell
$env:HOST = '0.0.0.0'
$env:DASHBOARD_PASSWORD = 'your-unique-password'
npm start
```

## How status works

- Checks run on the server, including when no browser is open. Website URLs must be reachable **from that server/container**. `localhost` inside Docker means the container itself. Use service DNS names on shared Docker networks or your server's LAN address for other services.
- Default: follow redirects and mark final HTTP 200–399 as online. A login page returning 200 means the web service is reachable, not that an authenticated application action works. To test deeper health, configure a dedicated health endpoint.
- Per site, you can also treat 401/403 as online for services that require authentication. Harbor does not log in during checks.
- A timeout, DNS/connect/TLS failure, or unexpected HTTP status is offline. Timeouts are eight seconds. HTTPS certificate verification stays enabled; for a private CA, mount the CA certificate and set `NODE_EXTRA_CA_CERTS` to its container path.
- Response time measures request-to-response-headers, including redirects, not full page load. Failed connections show no latency. The summary averages all measured responses, including HTTP errors.
- Choose a polling interval from 15 seconds to one hour. The next round starts that long after the previous round completes; up to five checks run concurrently. **Check now** starts a round unless one is already running. Sites edited or added during a round are checked by the next round.
- The browser refreshes status every two seconds without creating additional health checks. Unknown means no result yet. The last result, saved history and site settings survive restarts. The exact last-check timestamp remains visible so stale results can be recognized.
- Maximum 100 websites. Health checks are HTTP GETs; use read-only URLs without side effects. Every dashboard user can edit destinations, including private-network addresses, so only give access to trusted administrators.

## Persistence, backup and maintenance

Compose stores names, URLs, retention and relay settings in the `harbor-data` named volume at `/app/data/config.json`. History, recent results, incident state and the email queue live in `history.sqlite` and its SQLite sidecar files. The SMTP encryption key lives in `smtp.key` when needed. Without Docker these live in the app's `data` folder. Configuration changes use an atomic file replacement. Run one instance per data directory and keep SQLite on a local filesystem rather than an SMB/NFS share.

Stop without deleting settings:

```sh
docker compose down
```

Back up **the whole data directory** with Harbor stopped, using a new backup folder each time. This preserves configuration, history, any SQLite sidecar files and the SMTP key together:

```sh
docker compose stop harbor
docker compose cp harbor:/app/data ./harbor-backup
docker compose start harbor
```

To restore, first back up the current directory. Stop Harbor and restore the backup into an empty data volume/directory, keeping all files together; do not mix an old SQLite database with newer WAL/SHM sidecar files. Ensure the restored directory and files are owned by container user `node` (UID/GID 1000). For a newly prepared volume containing the restored files, ownership can be repaired before starting:

```sh
docker compose run --rm --user root harbor chown -R 1000:1000 /app/data
docker compose start harbor
```

Do not run `docker compose down -v` unless you want to delete saved configuration, history and SMTP credentials. To update application files, back up data, replace the package, then run `docker compose up -d --build`.

For logs: `docker compose logs --tail=100 harbor`. If a website is offline only in Harbor, check container DNS, routing/firewall, the certificate chain, and expected status selection. If Harbor cannot start, check the port, password setting, data-folder permissions and JSON validity. Invalid saved JSON fails startup rather than overwriting your configuration.

## Portainer

Build the image once on the Docker host from this folder: `docker build -t harbor-dashboard:local .`. In Portainer, create a stack using `compose.yaml`, remove the `build: .` line, and supply `DASHBOARD_PASSWORD`, `BIND_ADDRESS` and `PORT` as stack environment variables. This uses the locally built image; it is not published to a registry. Deploy on that same host. Keep the named volume when replacing the stack.

## Validation

Run `npm test` for integration checks covering real local HTTP health responses, timeout handling, persistent edits, authentication, input validation, cross-site mutation protection, history retention, mixed-status bars, encrypted SMTP secrets, incident deduplication across restarts and retries through a local SMTP test relay. Docker itself must be installed to verify the container build and Compose deployment. Your actual relay must be configured and tested on your server. No deployment to your home server is performed by extracting this package.

The optional read-only `read_website_statuses` WebMCP tool is feature-detected; ordinary browsers do not need WebMCP.
