# Deployment

FeltCircle is one static web app plus an **optional** multiplayer backend. Choose one option:

| Option | Local Mode | Online Multiplayer | You need |
|---|---|---|---|
| [A. Static hosting](#a-static-hosting-local-mode-only) | ✅ | ❌ (or ✅ with an external backend) | Any static host |
| [B. VPS + Docker Compose](#b-vps-with-docker-compose) | ✅ | ✅ | Linux VPS (x86-64 or ARM64), Docker, a reverse proxy |
| [C. VPS + systemd](#c-vps-with-systemd-no-docker) | ✅ | ✅ | Linux VPS, Node.js 22.13+, a reverse proxy |
| [D. Cloudflare](#d-cloudflare-workers--durable-objects) | ✅ | ✅ | Cloudflare account (the free plan is fine) |

All options use the **same** frontend build (`apps/web/dist`). Nothing in the repository refers to a particular domain, and there are no secrets to configure.

Build everything once with:

```bash
npm ci
npm run build        # → apps/web/dist and apps/server-node/dist/server.mjs
```

---

## A. Static hosting (Local Mode only)

Upload the contents of `apps/web/dist/` to any static host. It uses relative paths and hash routing, so it also works from a subpath such as `https://user.github.io/feltcircle/`. Upload `404.html` too: it makes invite links like `…/join/CFW27` work on hosts without rewrite rules.

- **GitHub Pages:** enable *Settings → Pages → Source: GitHub Actions*, then run the *Deploy web app to GitHub Pages* workflow (`.github/workflows/pages.yml`).
- **Cloudflare Pages:** *Workers & Pages → Create → Pages → Connect to Git*, framework preset *None*, build command `npm ci && npm run build:web`, build output directory `apps/web/dist`, environment variable `NODE_VERSION=22`. Or upload a local build: `npx wrangler pages deploy apps/web/dist --project-name feltcircle`. Pages serves `404.html` for unknown paths, so invite links work. (For multiplayer on Cloudflare, use option D instead: it serves the web app *and* the backend from one Worker.)
- **Netlify / Vercel:** build command `npm ci && npm run build:web`, output directory `apps/web/dist`.
- **Any web server:** copy the files and serve them over HTTPS. HTTPS is required for offline/PWA support.

The capability check will find no backend, so the home screen shows Online Multiplayer as unavailable. That's expected.

### Connecting a static frontend to a separate backend
Edit `config.json` next to `index.html` (no rebuild needed):

```json
{ "backendUrl": "https://chips.your-domain.example" }
```

Then add the frontend's origin to the backend's `CORS_ORIGINS` (e.g. `CORS_ORIGINS=https://user.github.io`). A frontend served over HTTPS needs a backend served over HTTPS (browsers block `ws://` from `https://` pages). On GitHub Pages, set the repository variable `FELTCIRCLE_BACKEND_URL` and the workflow writes `config.json` for you.

Players can also enter a server address on the home screen. Invite links carry it automatically (`…/join/ABCDE?server=…`).

---

## B. VPS with Docker Compose

Works on x86-64 and ARM64 (e.g. Oracle Cloud Ampere, Raspberry Pi 4/5, Hetzner CAX).

```bash
git clone <your fork URL> feltcircle && cd feltcircle
cp .env.example .env            # optional: adjust limits
docker compose up -d --build
curl http://127.0.0.1:8787/healthz        # → ok
curl http://127.0.0.1:8787/api/capabilities
```

The container serves both the web app and the API on **127.0.0.1:8787 only**. Data lives in the `feltcircle-data` Docker volume. Next, put a reverse proxy with HTTPS in front of it:

### Nginx
```bash
sudo cp deploy/nginx/feltcircle.conf /etc/nginx/conf.d/feltcircle.conf
sudo sed -i 's/YOUR_DOMAIN/chips.your-domain.example/g' /etc/nginx/conf.d/feltcircle.conf
sudo certbot certonly --webroot -w /var/www/html -d chips.your-domain.example   # or your usual method
sudo nginx -t && sudo systemctl reload nginx
```
The important parts are the WebSocket upgrade headers and the long `proxy_read_timeout` on `/ws` (the live-room endpoint; `/api/rooms/*/ws` is the older path and still accepted).

### OpenResty / 1Panel
Create a reverse-proxy website for your domain that targets `http://127.0.0.1:8787` and enables **WebSocket** support (in 1Panel: *Websites → Create → Reverse proxy*, then enable HTTPS).

For a hand-written OpenResty setup, `deploy/openresty/feltcircle.conf` is a complete working example. OpenResty serves the static files from `/opt/feltcircle/web` (with `/join/CODE` falling back to `index.html`) and proxies `/api/` and `/ws` to the backend:

```bash
sudo mkdir -p /opt/feltcircle/web && sudo cp -r apps/web/dist/. /opt/feltcircle/web/
sudo cp deploy/openresty/feltcircle.conf /usr/local/openresty/nginx/conf/conf.d/
sudo sed -i 's/YOUR_DOMAIN/chips.your-domain.example/g' /usr/local/openresty/nginx/conf/conf.d/feltcircle.conf
sudo openresty -t && sudo systemctl reload openresty
```

### Caddy
```
chips.your-domain.example {
    reverse_proxy 127.0.0.1:8787
}
```
(Caddy handles WebSockets and certificates automatically.)

Keep `TRUST_PROXY=true` (the default in `docker-compose.yml`) so rate limits use the real client IP from `X-Forwarded-For`. **Don't** publish the port publicly with `TRUST_PROXY=true`.

---

## C. VPS with systemd (no Docker)

Requires Node.js **22.13 or newer** on the server (`node --version`). The server is a single bundled file with no `node_modules`.

```bash
# On any machine with the repo:
npm ci && npm run build

# On the server:
sudo useradd --system --home /var/lib/feltcircle --shell /usr/sbin/nologin feltcircle
sudo mkdir -p /opt/feltcircle/web /etc/feltcircle
sudo cp apps/server-node/dist/server.mjs deploy/backup.sh /opt/feltcircle/
sudo cp -r apps/web/dist/. /opt/feltcircle/web/
sudo cp deploy/systemd/feltcircle*.service deploy/systemd/feltcircle-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now feltcircle feltcircle-backup.timer
curl http://127.0.0.1:8787/healthz
```

The unit already sets `HOST=127.0.0.1`, `PORT=8787`, `DATA_DIR=/var/lib/feltcircle`, `STATIC_DIR=/opt/feltcircle/web` and `TRUST_PROXY=true`. To change anything else (e.g. `CORS_ORIGINS`, `ROOM_CREATE_LIMIT`), put just those lines in `/etc/feltcircle/feltcircle.env`. That file is optional; values in it override the unit. Don't copy `.env.example` there wholesale, because its development defaults (`DATA_DIR=./data`, `TRUST_PROXY=false`) are wrong for this layout. Then configure the reverse proxy as in option B. Logs: `journalctl -u feltcircle -f`.

---

## D. Cloudflare (Workers + Durable Objects)

Deploys the web app (Workers Static Assets), the API Worker and the SQLite-backed Durable Objects in one step:

```bash
npm ci
npx wrangler login
npm run deploy:cloudflare
```

Wrangler prints the `*.workers.dev` URL. Open it and Online Multiplayer will be available. To use your own domain, add a *Custom Domain* to the Worker in the Cloudflare dashboard (*Workers & Pages → feltcircle → Settings → Domains & Routes*). The domain's DNS must be on Cloudflare. HTTPS certificates and WebSockets (`wss://`) are handled automatically.

Settings are in `apps/server-cloudflare/wrangler.toml` under `[vars]` (`CORS_ORIGINS`, `ROOM_CREATE_LIMIT`). Change the Worker `name` if you deploy more than one copy. You don't need to create KV, D1 or any other resource. The Durable Object migration (`new_sqlite_classes`) is applied automatically on first deploy.

Costs: idle rooms hibernate (WebSocket Hibernation API), and the heartbeat is answered by an auto-response without waking the object, so a typical home game stays well within the free tier.

Validate without deploying: `cd apps/server-cloudflare && npx wrangler deploy --dry-run --outdir /tmp/cf`.
Run locally in the real runtime: `npm run build:web && cd apps/server-cloudflare && npx wrangler dev`.

---

## Configuration reference (Node.js server)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address (Docker image: `0.0.0.0` inside the container) |
| `PORT` | `8787` | Listen port |
| `DATA_DIR` | `./data` | Directory for the database and backups |
| `DB_FILE` | `$DATA_DIR/feltcircle.sqlite` | Database path |
| `STATIC_DIR` | unset | Serve the web app from this directory |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IPs (enable only behind a proxy) |
| `CORS_ORIGINS` | `*` | Allowed cross-origin frontends (comma-separated) or `*` |
| `ROOM_CREATE_LIMIT` | `30` | Rooms per IP per hour |
| `MAX_ROOMS` | `5000` | Max simultaneously stored rooms |
| `CLEANUP_INTERVAL_MS` | `60000` | How often expired rooms are deleted |

---

## Backups and restore (Node.js)

Rooms only live for 24 hours, so backups mainly protect games in progress during maintenance. Backups are consistent snapshots that are safe to take while the server runs.

**Docker:**
```bash
docker compose exec feltcircle node server.mjs backup          # → /data/backups/ in the volume
docker compose cp feltcircle:/data/backups ./backups            # copy out
```
Restore:
```bash
docker compose stop feltcircle
docker compose run --rm --no-deps -v "$PWD/backups/<file>.sqlite:/restore.sqlite:ro" feltcircle \
  sh -c 'cp /restore.sqlite /data/feltcircle.sqlite && rm -f /data/feltcircle.sqlite-wal /data/feltcircle.sqlite-shm'
docker compose start feltcircle
```

**systemd:** `feltcircle-backup.timer` runs `/opt/feltcircle/backup.sh` daily and keeps the newest 14 snapshots in `/var/lib/feltcircle/backups` (set `KEEP` to change). Restore:
```bash
sudo systemctl stop feltcircle
sudo -u feltcircle cp /var/lib/feltcircle/backups/<file>.sqlite /var/lib/feltcircle/feltcircle.sqlite
sudo rm -f /var/lib/feltcircle/feltcircle.sqlite-wal /var/lib/feltcircle/feltcircle.sqlite-shm
sudo systemctl start feltcircle
```

**Cloudflare:** Durable Object storage is managed and replicated by Cloudflare. No backup job is needed.

## Updating

- **Docker:** `git pull && docker compose up -d --build`
- **systemd:** rebuild, copy the new `server.mjs` and `web/` into `/opt/feltcircle`, then `sudo systemctl restart feltcircle`
- **Cloudflare:** `git pull && npm ci && npm run deploy:cloudflare`
- **Static:** upload the new `apps/web/dist`

Database migrations run automatically at startup. Rooms in progress are restored after a restart, and connected phones reconnect by themselves within a few seconds. If an update changes the protocol version, players see a "please reload" message. Restarting between hands is the least disruptive time.

## Custom domains and HTTPS/WSS

- Online play needs HTTPS. Browsers block `ws://` from `https://` pages, and the app uses `wss://` automatically when the page is served over HTTPS.
- **VPS:** point an `A`/`AAAA` record at the server, then get a certificate (`certbot`, Caddy, or your panel). The reverse proxy terminates TLS and forwards plain HTTP/WebSocket to `127.0.0.1:8787`.
- **Cloudflare Workers:** add a Custom Domain to the Worker (see option D).
- **GitHub Pages:** *Settings → Pages → Custom domain*, then enable *Enforce HTTPS*. If the backend is elsewhere, add the new origin to its `CORS_ORIGINS`.
- **Cloudflare in front of a VPS (orange cloud):** WebSockets are supported. Use SSL mode *Full (strict)*.

## Cleanup

Expired rooms (24 h after the last meaningful activity) are deleted automatically: by a periodic sweeper on Node.js, and by each Durable Object's alarm on Cloudflare. Hosts can delete a room immediately from the game menu.
