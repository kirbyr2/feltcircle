# Troubleshooting

## "Online Multiplayer unavailable" on the home screen

The app couldn't reach a compatible backend at `GET <backend>/api/capabilities`.

1. Open `<your site>/api/capabilities` in a browser. You should see JSON containing `"app":"feltcircle"`.
   - **HTML instead of JSON:** the request is reaching the static site, not the backend. Check the reverse proxy forwards `/api/` (or everything) to `127.0.0.1:8787`. On Cloudflare, make sure `run_worker_first = ["/api/*", "/ws"]` is still in `wrangler.toml`.
   - **502/504:** the backend isn't running. Check `docker compose ps` / `docker compose logs`, or `journalctl -u feltcircle`.
2. If the frontend and backend are on **different origins**, `config.json` must contain the backend URL, and the backend's `CORS_ORIGINS` must include the frontend origin (or `*`).
3. An `https://` site can't use an `http://` backend (mixed content). Serve the backend over HTTPS.
4. A server address entered on the home screen overrides everything else. Clear it if it's stale.
5. Press **Retry**. Detection never blocks Local Mode.

## Players keep showing "Reconnecting…"

The HTTP API works but WebSockets don't.

- The proxy must pass `Upgrade`/`Connection` headers and use HTTP/1.1 upstream for `/ws` (and the older `/api/rooms/<ID>/ws`). See `deploy/nginx/feltcircle.conf` or `deploy/openresty/feltcircle.conf`. A proxy that only forwards `/api/` will serve the app but never connect: add a `location = /ws` block. In 1Panel/OpenResty, enable the WebSocket option on the reverse-proxy site.
- Raise `proxy_read_timeout` (the example uses 1 h). The app sends a heartbeat every 20 seconds, but some proxies still drop upgraded connections early.
- Corporate/hotel Wi-Fi sometimes blocks WebSockets. Try mobile data.
- Run `FC_LIVE_URL=https://your-site npx vitest run tests/live-backend.test.ts` from a checkout to test the full path.

## Invite links (`/join/CODE`) show "Not found"

Invite links are real paths such as `https://example.com/join/CFW27`. The app turns them into its internal `#/join/CFW27` route.

- **Node server / Docker / Cloudflare:** handled automatically (SPA fallback).
- **Nginx/OpenResty serving the static files itself:** use `try_files $uri $uri/ /index.html;` in `location /`.
- **GitHub Pages and other static hosts:** the build writes `404.html`, which performs the same redirect. Make sure you uploaded it together with `index.html`.
- `#/join/CFW27` (and the older `#/room/CFW27`) always work, even without any of the above.

## My seat number changed when the game started

That's expected. In the waiting room everyone keeps the seat they picked. When the host starts the game, empty seats are removed and the players are renumbered 1, 2, 3, … in the same clockwise order (for example 1, 2, 4, 6 → 1, 2, 3, 4). Sit around the physical table in that order. Reloading or reconnecting always returns you to your new seat.

## A late player is stuck on "Waiting for the host"

After the game starts, new players can't sit down directly. They send a request that the host must approve. The host sees a *Join requests* banner on the table (also in the game menu) and chooses the new player's chips. If the table is full, the host can raise the table size (up to 10) in the game menu first.

## No sound

- Browsers only allow audio after you have touched the page once. Tap anywhere.
- Check the speaker button on the table and **Settings → Sound** (on/off, volume). These settings are per device.
- On iPhone, the ring/silent switch mutes web audio.

## WebSocket returns 403

The page's origin isn't allowed. Same-origin is always allowed (Nginx must forward `Host`: `proxy_set_header Host $host;`). For a separate frontend, add its origin to `CORS_ORIGINS`.

## "Too many requests" when creating rooms

The per-IP limit (`ROOM_CREATE_LIMIT`, default 30/hour) was hit. Behind a proxy without `TRUST_PROXY=true`, every player appears to come from `127.0.0.1` and shares one limit. Set `TRUST_PROXY=true` (and keep the port bound to localhost).

## A player lost their seat / "Your seat link is no longer valid"

Seats are tied to a random token stored in the player's browser. Clearing site data, using a private window, or switching phones loses it. The player can open the room again, pick their seat (shown as offline) and choose **Take over offline seat**. This only works while that seat has no active connection.

## Someone was folded automatically

Players who are disconnected for **30 seconds** (or who set themselves to Away) are auto-folded when it is their turn (they are never auto-checked). The server does this, so the game never stalls. All-in players are never folded. When the player reconnects, auto-fold switches off automatically.

## The host left

When the host is disconnected, any seated player sees **Become host**. The old host returns as a normal player and can be given host back via *Transfer host*.

## Chip import is rejected

- `TOTAL_MISMATCH`: the text was cut off or edited. Copy it again in full, including `T=…`.
- "Choose what to do with missing seats": the import doesn't cover every occupied seat. Pick *starting chips* or *0* for them.
- Import is only possible **between hands**. It is an admin reset and is recorded in the room history.

## The room disappeared

Rooms are deleted 24 hours after the last game action or host command, or immediately when the host deletes them. Use **Export chips** to carry stacks into a new room.

## Local game data

Local games are stored only in that browser on that device. Use **Export chips** before clearing browser data or switching devices.

## Node server won't start

- `node:sqlite` not found / `ERR_UNKNOWN_BUILTIN_MODULE`: Node is older than 22.13. Upgrade Node.
- `EADDRINUSE`: another program uses the port. Change `PORT`.
- `SQLITE_CANTOPEN` / permission denied: the `DATA_DIR` isn't writable by the service user (systemd: `/var/lib/feltcircle`, owned by `feltcircle`).

## Cloudflare deploy fails

- "Durable Objects require a paid plan": SQLite-backed Durable Objects are available on the Workers Free plan. Make sure the migration uses `new_sqlite_classes`, not `new_classes`.
- Assets missing: run `npm run build:web` first (the `deploy:cloudflare` script does this).
- Name conflict: change `name` in `wrangler.toml`.

## Reporting a bug

Include the browser, device, deployment type, steps to reproduce, and the server log lines around the time. Never post seat tokens or invite links of active rooms in public issues.
