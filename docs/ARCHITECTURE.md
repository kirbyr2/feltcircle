# Architecture

FeltCircle is an npm-workspaces TypeScript monorepo. One rules engine and one room state machine are shared by **every** mode and backend. That way Local Mode, the Node.js server and Cloudflare cannot drift apart.

```
                ┌─────────────── apps/web (static PWA, identical build everywhere) ───────────────┐
                │  React UI ── game-session ──┬── LocalSession  (room-core in the browser)        │
                │                             └── ServerSession (WebSocket client)                │
                └─────────────────────────────────────────┬───────────────────────────────────────┘
                                                          │ HTTP + WebSocket (game-protocol)
                   ┌──────────────────────────────────────┴───────────────────────────────┐
     apps/server-node (Node.js, ws, node:sqlite)                apps/server-cloudflare (Worker + Durable Objects)
                   └──────────── both host room-core's RoomRuntime ────────────────────────┘
                                                          │
                       room-core (rooms, seats, host, automation, views)
                                                          │
                     poker-engine (NLHE rules, pots, blinds)   chip-export (FC1 format)
```

## Packages

### `poker-engine`
Pure functions over plain JSON state, with no I/O, timers or randomness:

- `createTournament`, `startHand`, `legalActions`, `applyAction`, `advanceStreet`, `awardPots`, `setBlindConfig`, `resetChips`, `pauseClock`/`resumeClock`.
- **Positions:** the button moves one live seat per hand, and the big blind always advances (a "moving big blind" approach). Heads-up, the button posts the small blind and acts first preflop.
- **Betting:** `currentBet`, `minRaise` (the size of the last full raise), and per-seat `actedLevel`. A short all-in that is less than a full raise does not reopen the betting for players who have already acted. Players facing it may only call or fold, and `legalActions().fullMinTo` exposes this to the UI.
- **Pots:** `computePots` builds main/side pots by contribution level. Folded chips stay in the pot, but folded players aren't eligible to win it. Uncalled bets are refunded when a betting round ends. `displayPots` shows only splits caused by all-ins while betting is still in progress.
- **Showdown:** the host picks winner(s) per pot. `splitPot` gives odd chips one at a time, clockwise from the button.
- **Blinds:** `generateLevels` scales a standard ladder from the starting big blind. `levelFor` uses time (`levelMinutes`), eliminations (`playersPerLevel`) or a hybrid (whichever is higher; it never goes back down). Paused time does not count.
- Invariant: `totalChips(t)` is constant. A 40-game random fuzz test checks it after every action.

### `chip-export`
`FC1 1=2500 2=1750 T=4250` (compact) or `{"version":1,"seats":{"1":2500,...}}` (JSON). `parseChips` never throws and returns typed error codes. `resolveImport` compares the import against the room's seats. Seats missing from the import need an explicit choice (starting stack or 0). Only seat numbers and chip counts are exported, never names, rooms or tokens.

### `game-protocol`
Shared wire types and validation. Both servers use the same parser.

- `GET /api/capabilities` → `{ app: "feltcircle", protocolVersion, features, games, server: { platform, version } }`. `games` lists the game IDs the backend accepts (`["texas-holdem"]`). The UI shows the shared `GAME_CATALOG`, identical for Local Mode and every backend.
- `POST /api/rooms` `{ game, settings, nickname }` → `{ roomId, token, seat: 1 }`. `game` defaults to `texas-holdem`. Unknown or not-yet-available games (e.g. `riichi-mahjong`) are rejected with `UNSUPPORTED_GAME`.
- `GET /api/rooms/:id` → room summary (exists, game type, status, free and requested seats). It never includes tokens.
- `WS /ws?room=:id` (the older `/api/rooms/:id/ws` is still accepted): client messages are `hello`, `join`, `cmd`, `ping`. Server messages are `welcome`, `joined`, `state`, `ack`, `error`, `deleted`, `pong`.

The web app and API share one origin by default (`/api/capabilities`, `/api/rooms`, `/ws`), so a single reverse-proxy site is enough.

Every client message is size-limited (16 KB) and validated field by field before it reaches room logic (`parseClientMessage`, `validateCommand`). Nicknames are cleaned of control and bidi characters and length-limited.

### `room-core`
The authoritative room state machine (`RoomState`, schema-versioned JSON):

- Seats have a random **seat token** (≥128 bits) that is the only credential. Room IDs are invitations, **not** authentication.
- `applyCommand(state, actor, cmd, now, commandId)` is atomic: it works on a copy and commits only on success. It is also idempotent: a repeated command ID returns the cached result, so resending after a reconnect is safe.
- Host rules: the host can act for nobody except through explicit host commands (force-fold an offline player, award pots, and so on). `claimHost` is allowed only while the host is disconnected.
- Automation (`runAutomation`): after each change and on each timer, seats that have been offline for ≥30 s or are marked away are auto-**folded** when it's their turn (never auto-checked). Queued pre-actions (Fold, Check/Fold, Call Any) run as well. All-in players need no action and are never folded.
- **Seat renumbering at the start:** in the waiting room, players keep the seat they picked (e.g. 1, 2, 4, 6). `host:start` closes the gaps once, inside the same atomic command: the lowest occupied seat becomes 1 and the rest follow clockwise (1, 2, 3, 4). Every seat-based reference moves with the player: seat records (nickname, reconnect token, connection state), the host, the dealer chosen in the waiting room, chip imports, pre-actions, idempotency keys and the room history. The game is then created directly with the new numbers, so turn order, blinds and actions never see the old ones. `applyCommand` returns the `seatMap`, and `RoomRuntime` rebinds every live connection to its new seat before broadcasting (on Cloudflare the binding lives in the hibernation-safe socket attachment). Each `RoomView` carries `viewerSeat`, so clients learn their new number from the next state; reconnecting clients resolve their seat from their token as usual. Seats are never renumbered between hands, and late joiners keep the free seat they asked for.
- **Late joining:** once the game has started, `join` on a free seat creates a *join request* instead of a seat. The host approves it with a chosen stack (default: the starting chips) or rejects it. An approved player is seated immediately and dealt in from the next hand. The host may raise the table size (up to 10 seats) during the game to make room.
- **Flexible chips:** there is no fixed chip supply. Between hands the host can set any seat's balance (`host:setChips`), e.g. to correct a mistake or re-buy a busted player. Every adjustment is recorded in the room log (`chipsAdjusted {seat, from, to}`). Within a hand, chips are always conserved.
- **Victory claims:** at showdown, players can tap *I Won!* (a synced, withdrawable claim limited to pots they are eligible for) or *I Lost / Muck*. Claims never move chips; they only pre-select winners for the host, who still confirms every pot. Mucking is refused when the player is the last contender of a pot (`CANNOT_MUCK`).
- `undo` keeps a bounded stack of snapshots for the current hand.
- `toView(state, viewerSeat)` makes the per-viewer `RoomView` the clients render. It never includes tokens.
- `RoomRuntime` wraps a room for a backend. It routes messages, tracks connections, rate-limits each connection (40 messages / 10 s), saves after every change, and schedules a single wake-up time (`nextWakeAt`) for auto-fold, blind clock and expiry. A backend only has to provide `connections`, `save`, `remove`, `setWake` and `now`.

### `game-session`
The client-side abstraction the UI uses:

- `LocalSession` runs `room-core` in the browser with `actor.local = true` (one device controls every seat) and saves after every change.
- `ServerSession` handles the WebSocket connection with `hello` + token resume, an application-level heartbeat, dead-connection detection, exponential-backoff reconnect, and acks with timeouts. While disconnected it refuses to send commands, so no action is applied twice or lost silently.
- `detectBackend` performs the non-blocking capability probe.

## Backends

### Node.js (`apps/server-node`)
- One process: `http` + `ws`, SQLite via the built-in `node:sqlite` (no native addon, so it builds unchanged on ARM64).
- Each room is stored as one row (`id, state JSON, version, updated_at, expires_at`), written in a single upsert after every committed command. Schema migrations run at startup (`PRAGMA user_version`). WAL mode is enabled.
- Active rooms are kept in memory as `RoomRuntime`s and loaded lazily from SQLite, so they survive restarts. One timer per room drives automation, and a sweeper deletes expired rooms.
- Per-IP room-creation limits (uses `X-Forwarded-For` only when `TRUST_PROXY=true`) and a global cap on rooms. WebSocket origin is checked against `CORS_ORIGINS` / same-origin.
- Optionally serves the static web app (`STATIC_DIR`) with SPA fallback and long-term caching for hashed assets.
- `node server.mjs backup [file]` writes a consistent online snapshot (`VACUUM INTO`).

### Cloudflare (`apps/server-cloudflare`)
- The Worker routes `/api/*` and `/ws` (`run_worker_first`), and Workers Static Assets serves the same `apps/web/dist`.
- `RoomDurableObject` (SQLite-backed storage) holds one room. It uses the **WebSocket Hibernation API** (`acceptWebSocket`, socket attachments for seat/connection IDs, an auto-response for heartbeat pings, so idle rooms cost nothing) and a single **Alarm** for auto-fold, the blind clock and expiry (24 h → `deleteAll`).
- `RateLimiterDurableObject` keeps per-IP room-creation windows.
- No KV, D1, Queues or Redis.
- The DO classes are plain classes. They don't extend `DurableObject`, so the same code is exercised in Node by `tests/consistency.test.ts` using in-memory fakes, and verified in the real runtime by `wrangler dev` + `tests/live-backend.test.ts`.

## Web app (`apps/web`)
- React 19 + Vite. The build is fully static, uses relative paths (`base: './'`) and hash routing, so it works from any subpath (GitHub Pages) without server rewrites.
- **Invite links** look like `https://example.com/join/CFW27`. A few lines in `index.html` rewrite `/join/CODE` to the hash route `#/join/CODE`. The build also writes `404.html` (a copy of `index.html`), so the link works on static hosts that have no rewrite rules (GitHub Pages) as well as on the Node server and Cloudflare (SPA fallback).
- **Game selection:** both modes start with the same catalog screen. Texas Hold'em is available; Riichi Mahjong is listed as *Coming Soon* and cannot be selected.
- **Backend resolution:** a user override (Settings → server address, or an invite link's `?server=`) → `config.json` next to `index.html` → same origin. Changing the backend never needs a rebuild.
- **Capability detection** runs in the background. Local Mode is usable immediately, and Multiplayer shows "checking…", then either becomes available or shows a greyed-out state with Retry.
- A service worker generated at build time precaches the app shell, so Local Mode works offline. API calls are never cached.
- **Translations** use i18next + react-i18next with flat, stable keys (`action.fold`) and `{name}` placeholders, one JSON file per language in `packages/i18n`. Locales are bundled with the app (lazy-loaded chunks), so no translation service is contacted. Language: personal choice (stored locally) > room default > browser language > English.
- **Sound effects** (`lib/sound-events.ts`, `lib/sound.ts`): blind, bet, call, raise, all-in, fold, check, win and hand-complete sounds are derived only from *confirmed* state changes (new hand-log entries between two authoritative room versions), never from button presses. The first view after opening or reconnecting plays nothing, so sounds never repeat on reconnect. Audio starts after the first tap or key press (browser autoplay rules). Sounds are on by default at a moderate volume; mute and volume are saved per device. The WAV files are synthesised by `apps/web/scripts/make-sounds.mjs` and are original to this project.
- **Hand Rankings guide:** the ten categories with an example hand drawn with CSS cards, plus comparison rules (kickers, ties and split pots, ace-high/ace-low straights, flushes, unranked suits, best five of seven). It works offline in every language. It is reference material only: FeltCircle never deals or evaluates cards.

## Persistence and retention
| Data | Where | Lifetime |
|---|---|---|
| Online room state | SQLite row / Durable Object storage | 24 h after the last meaningful activity (actions, host commands, joins). Connections and heartbeats do not extend it. Deleted immediately when the host deletes the room. |
| Seat token | Player's browser (`localStorage`, per backend + room) | Until the room ends |
| Local game | Browser storage on that device | Until discarded |

## Security model
FeltCircle has no money and no accounts, so the goal is fairness and robustness, not identity:

- The server is authoritative. Clients send intents, and the server validates turn, phase, amounts and permissions. Clients can't set balances.
- Seat tokens are unguessable random values. Room IDs are short invitations (31-symbol alphabet without `0/O/1/I/L`) generated with `crypto.getRandomValues` using rejection sampling, and regenerated on collision.
- Inputs are size-limited and validated. Rates are limited per IP (room creation) and per connection (messages).
- Updates are atomic and idempotent. Chip totals are conserved by construction and tested.
- No secrets are needed anywhere in the stack.
