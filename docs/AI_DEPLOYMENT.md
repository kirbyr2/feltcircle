# Deploying FeltCircle with an AI coding assistant

This file is for AI agents (Claude Code, Codex, Cursor, etc.) that deploy FeltCircle for a user. Humans can read it too. It is a checklist with exact commands and the facts an agent needs to avoid common mistakes. The long-form human guide is [DEPLOYMENT.md](DEPLOYMENT.md).

## Ground rules for the agent

1. **Ask the user** which target they want before changing anything on a server, and ask for the domain name if there is one. Never invent or assume a domain. There is no official public FeltCircle server.
2. **Do not** create accounts, buy domains, open firewall ports, or change DNS without explicit permission. Do not touch unrelated sites in an existing Nginx/OpenResty/1Panel setup.
3. **No secrets are required.** FeltCircle needs no API key, database password or token. If you find yourself adding one to this project, stop. A Cloudflare login/token belongs to the user's environment only and must never be committed.
4. Prefer the repository's files (`docker-compose.yml`, `deploy/…`, `wrangler.toml`, `.github/workflows/pages.yml`) over writing new ones.
5. Run `nginx -t` / `openresty -t` before every reload. Make backups of any file you replace.
6. Finish with **[Capability verification](#10-capability-verification)** and report the results honestly, including failures.

## Facts

- Node.js **≥ 22.13** is required to build, and to run the Node server (`node:sqlite`). Check with `node --version`.
- `npm ci && npm run build` produces:
  - `apps/web/dist/`: the static frontend (identical for every target, includes `404.html` and `config.json`)
  - `apps/server-node/dist/server.mjs`: the complete Node server, one file with no `node_modules` needed
- Same-origin endpoints: `GET /api/capabilities`, `POST /api/rooms`, `GET /api/rooms/<ID>`, WebSocket `/ws?room=<ID>` (the older `/api/rooms/<ID>/ws` is also accepted). A reverse proxy must forward **both `/api/` and `/ws`** and allow WebSocket upgrades on `/ws`.
- Invite links look like `https://<domain>/join/CFW27`. They need either SPA fallback (Node, Cloudflare, `try_files … /index.html`) or the bundled `404.html` (static hosts).
- The Node server listens on **127.0.0.1:8787** by default. Health: `GET /healthz` → `ok`.
- The frontend finds the backend through: the user's override → `config.json` `backendUrl` → same origin. For same-origin deployments leave `config.json` as `{"backendUrl": ""}`.
- Works on ARM64. The Docker image uses `node:22-bookworm-slim` (multi-arch) and has no native modules.

---

## 1. GitHub Pages (static, Local Mode)

Local Mode only, unless paired with a backend hosted elsewhere.

1. Push the repository to GitHub.
2. *Settings → Pages → Build and deployment → Source: GitHub Actions*.
3. Run the workflow *Deploy web app to GitHub Pages* (`.github/workflows/pages.yml`), or push to `main`.
4. Optional backend: set the repository **variable** (not a secret) `FELTCIRCLE_BACKEND_URL=https://<backend>`; the workflow writes it into `config.json`. Then add `https://<user>.github.io` to the backend's `CORS_ORIGINS`.

The site works from the `/<repo>/` subpath. Expect "Online Multiplayer unavailable" when no backend is configured. That is correct.

## 2. Cloudflare Pages (static, Local Mode)

Git integration: *Workers & Pages → Create → Pages → Connect to Git*. Framework preset *None*, build command `npm ci && npm run build:web`, output directory `apps/web/dist`, environment variable `NODE_VERSION=22`.

Or direct upload from a checkout (the user must be logged in to wrangler):

```bash
npm ci && npm run build:web
npx wrangler pages deploy apps/web/dist --project-name feltcircle
```

For multiplayer on Cloudflare, use **section 5** instead: one Worker serves the web app and the backend together, which is simpler than Pages plus a separate backend.

## 3. Node.js on a VPS (systemd, no Docker)

```bash
node --version                      # must be ≥ 22.13
npm ci && npm run build
sudo useradd --system --home /var/lib/feltcircle --shell /usr/sbin/nologin feltcircle
sudo mkdir -p /opt/feltcircle/web /etc/feltcircle
sudo cp apps/server-node/dist/server.mjs deploy/backup.sh /opt/feltcircle/
sudo cp -r apps/web/dist/. /opt/feltcircle/web/
sudo cp deploy/systemd/feltcircle*.service deploy/systemd/feltcircle-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now feltcircle feltcircle-backup.timer
curl -fsS http://127.0.0.1:8787/healthz
```

The unit sets `HOST=127.0.0.1`, `PORT=8787`, `DATA_DIR=/var/lib/feltcircle`, `STATIC_DIR=/opt/feltcircle/web`, `TRUST_PROXY=true`. Put only overrides in `/etc/feltcircle/feltcircle.env`. **Do not** copy `.env.example` there (its development defaults are wrong for this layout). Logs: `journalctl -u feltcircle -f`. Then configure a reverse proxy (section 7).

## 4. Docker Compose on a VPS

```bash
docker --version && docker compose version
git clone <repo URL> feltcircle && cd feltcircle
cp .env.example .env              # optional
docker compose up -d --build
sleep 5; curl -fsS http://127.0.0.1:8787/healthz
```

The container serves the web app and API on `127.0.0.1:8787` only. Data is in the `feltcircle-data` volume. If 8787 is taken, set `PORT=<free port>` in `.env` and point the proxy at it. Then configure a reverse proxy (section 7).

## 5. Cloudflare Workers + Durable Objects (full multiplayer)

```bash
npm ci
npx wrangler whoami || npx wrangler login     # a person must complete the browser login
npm run deploy:cloudflare
```

This deploys the static app (Workers Static Assets), the API Worker and the SQLite-backed Durable Objects together. Nothing needs to be created in the dashboard: no KV, D1 or R2. Alternatively the user may export `CLOUDFLARE_API_TOKEN` in their own shell. Never write it into the repo.

Before deploying for real, you can validate with: `cd apps/server-cloudflare && npx wrangler deploy --dry-run --outdir "$(mktemp -d)"`. `wrangler.toml` must keep `run_worker_first = ["/api/*", "/ws"]`.

## 6. Custom domains

- **VPS (sections 3 and 4):** ask the user to create an `A`/`AAAA` DNS record for the chosen hostname pointing at the server, then wait until `dig +short <host>` returns the server IP before requesting a certificate.
- **Cloudflare Workers:** *Workers & Pages → feltcircle → Settings → Domains & Routes → Add → Custom Domain*. The zone must be on Cloudflare. DNS and certificate are created automatically.
- **Cloudflare Pages:** *project → Custom domains → Set up a domain*.
- **GitHub Pages:** *Settings → Pages → Custom domain*, then tick *Enforce HTTPS*.
- If the frontend and backend end up on different origins, set `backendUrl` in `config.json` and add the frontend origin to the backend's `CORS_ORIGINS`.

## 7. HTTPS and secure WebSockets (WSS)

Online play must be served over HTTPS. Browsers block `ws://` from `https://` pages, and the app automatically uses `wss://` when the page is HTTPS. Cloudflare and GitHub Pages provide HTTPS automatically. On a VPS, use a reverse proxy that terminates TLS:

- **Nginx:** `deploy/nginx/feltcircle.conf` proxies everything to the backend, with WebSocket upgrades on `/ws`.
  ```bash
  sudo cp deploy/nginx/feltcircle.conf /etc/nginx/conf.d/feltcircle.conf
  sudo sed -i 's/YOUR_DOMAIN/<host>/g' /etc/nginx/conf.d/feltcircle.conf
  sudo certbot certonly --webroot -w /var/www/html -d <host>
  sudo nginx -t && sudo systemctl reload nginx
  ```
- **OpenResty:** `deploy/openresty/feltcircle.conf` serves the static files itself (`/opt/feltcircle/web`) and proxies `/api/` and `/ws`. Same steps; test with `openresty -t`.
- **1Panel / other panels:** create a reverse-proxy site to `http://127.0.0.1:8787`, enable **WebSocket** and HTTPS through the panel UI. Don't hand-edit the panel's generated files.
- **Caddy:** `<host> { reverse_proxy 127.0.0.1:8787 }` (certificates and WebSockets are automatic).

Required proxy properties: HTTP/1.1 upstream with `Upgrade`/`Connection` headers on `/ws`, `Host` forwarded, `proxy_read_timeout` of at least several minutes (examples use 1 h), and `X-Forwarded-For` set (the server trusts it only with `TRUST_PROXY=true`, so keep port 8787 bound to localhost).

## 8. Backup and recovery

Rooms only live 24 hours, so backups mainly protect games in progress during maintenance. Snapshots are consistent and safe to take while the server runs.

- **Docker:** `docker compose exec feltcircle node server.mjs backup`, then `docker compose cp feltcircle:/data/backups ./backups`.
- **systemd:** `feltcircle-backup.timer` already runs daily and keeps 14 snapshots in `/var/lib/feltcircle/backups`. On demand: `sudo systemctl start feltcircle-backup`.
- **Restore (systemd):**
  ```bash
  sudo systemctl stop feltcircle
  sudo -u feltcircle cp /var/lib/feltcircle/backups/<file>.sqlite /var/lib/feltcircle/feltcircle.sqlite
  sudo rm -f /var/lib/feltcircle/feltcircle.sqlite-wal /var/lib/feltcircle/feltcircle.sqlite-shm
  sudo systemctl start feltcircle
  ```
  For Docker, see *Backups and restore* in [DEPLOYMENT.md](DEPLOYMENT.md).
- **Cloudflare:** Durable Object storage is managed by Cloudflare; no backup job is needed.
- **Static hosts:** nothing to back up. Local games live on each device; players can use *Export chips*.

## 9. Updates

Prefer updating when no hand is in progress. Migrations run automatically, rooms survive restarts, and phones reconnect by themselves.

- **Docker:** `git pull && docker compose up -d --build`
- **systemd:** `git pull && npm ci && npm run build`, copy `server.mjs` and `web/` into `/opt/feltcircle`, then `sudo systemctl restart feltcircle`. For OpenResty serving static files, also refresh `/opt/feltcircle/web`.
- **Cloudflare Workers:** `git pull && npm ci && npm run deploy:cloudflare`
- **GitHub Pages / Cloudflare Pages:** push to the deployed branch (or rerun the workflow / `wrangler pages deploy`).

Take a backup first (section 8) on a VPS.

## 10. Capability verification

Run all of these and report each result. Replace `$BASE` with the public URL, e.g. `https://chips.example.org`.

```bash
curl -fsS $BASE/api/capabilities          # JSON with "app":"feltcircle" and a "games" list
curl -fsS -o /dev/null -w '%{http_code}\n' $BASE/                 # 200
curl -fsS -o /dev/null -w '%{http_code}\n' $BASE/join/ABCDE        # 200 (SPA fallback) or 404 with 404.html on static hosts
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"game":"texas-holdem","settings":{}}' $BASE/api/rooms     # {"roomId":...,"token":...}
curl -sS -X POST -H 'content-type: application/json' \
  -d '{"game":"riichi-mahjong","settings":{}}' $BASE/api/rooms   # error UNSUPPORTED_GAME (expected)
curl -fsS $BASE/healthz                    # Node only: ok
# Full game over WSS through the proxy (from a checkout with dependencies installed):
FC_LIVE_URL=$BASE npx vitest run tests/live-backend.test.ts
```

`tests/live-backend.test.ts` creates a room, joins a second player over `/ws`, plays a hand, checks server-side validation, reconnects and deletes the room. If it passes, HTTPS, WebSockets and persistence all work.

Static-only deployments (sections 1 and 2): `/api/capabilities` returns HTML or 404 by design. Verify instead that `$BASE/` returns 200 and that the home screen offers *New local game*.

Finally, open the site on a phone: choose *Create room → Texas Hold'em*, scan the QR code with a second phone, and check that both see the same table.
