# Harbor

A lightweight, self-hosted directory for your websites. See online/offline status, response time and the exact last-check time; open a service or its sign-in page; and add, edit or remove websites from the dashboard.

Node.js 22+ with **no third-party runtime packages**, no build step, no external fonts, and no hosted services. The Sites design workflow was used, but this package runs on your home server rather than cloud hosting so it can reach private addresses.

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

Install Node.js 22 or newer. In the `harbor` folder:

```sh
npm start
```

Open **http://127.0.0.1:8080**. By default this binds to loopback and needs no password, suitable for a local preview. No `npm install` is needed. For LAN use, set `HOST=0.0.0.0` and `DASHBOARD_PASSWORD` in the process environment before starting; the app refuses an unprotected non-loopback bind. The `.env` file is read by Compose, not by `npm start`. Optional environment settings: `PORT` (8080), `DATA_DIR` (the app's `data` folder).

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
- The browser refreshes status every two seconds without creating additional health checks. Unknown means no result yet. Status results are in memory and reset on restart; site settings persist. The exact last-check timestamp remains visible so stale results can be recognized.
- Maximum 100 websites. Health checks are HTTP GETs; use read-only URLs without side effects. Every dashboard user can edit destinations, including private-network addresses, so only give access to trusted administrators.

## Persistence, backup and maintenance

Compose stores names, URLs and polling settings in the `harbor-data` named volume at `/app/data/config.json`. Without Docker they live in `data/config.json`. Changes use an atomic file replacement. Run one instance per data directory.

Stop without deleting settings:

```sh
docker compose down
```

Back up settings to the current folder while the container is running:

```sh
docker compose cp harbor:/app/data/config.json ./harbor-config-backup.json
```

To restore, first keep a copy of the current configuration, stop the service, copy the backup to the stopped container and start it again:

```sh
docker compose stop harbor
docker compose cp ./harbor-config-backup.json harbor:/app/data/config.json
docker compose run --rm --user root harbor chown 1000:1000 /app/data/config.json
docker compose start harbor
```

Ensure the restored file is writable by container user `node` (UID 1000). Do not run `docker compose down -v` unless you want to delete saved configuration. To update application files, back up settings, replace the package, then run `docker compose up -d --build`.

For logs: `docker compose logs --tail=100 harbor`. If a website is offline only in Harbor, check container DNS, routing/firewall, the certificate chain, and expected status selection. If Harbor cannot start, check the port, password setting, data-folder permissions and JSON validity. Invalid saved JSON fails startup rather than overwriting your configuration.

## Portainer

Build the image once on the Docker host from this folder: `docker build -t harbor-dashboard:local .`. In Portainer, create a stack using `compose.yaml`, remove the `build: .` line, and supply `DASHBOARD_PASSWORD`, `BIND_ADDRESS` and `PORT` as stack environment variables. This uses the locally built image; it is not published to a registry. Deploy on that same host. Keep the named volume when replacing the stack.

## Validation

Run `npm test` for integration checks covering real local HTTP health responses, timeout handling, persistent edits, authentication, input validation and cross-site mutation protection. Docker itself must be installed to verify the container build and Compose deployment. No deployment to your home server is performed by extracting this package.

The optional read-only `read_website_statuses` WebMCP tool is feature-detected; ordinary browsers do not need WebMCP.
