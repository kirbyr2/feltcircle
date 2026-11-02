import {
  advanceStreet,
  applyAction,
  awardPots,
  createTournament,
  currentPots,
  defaultConfig,
  displayPots,
  EngineError,
  generateLevels,
  legalActions,
  liveSeats,
  msUntilNextLevel,
  muck,
  pauseClock,
  playersPerLevelFor,
  seatPlayer,
  setSeatChips,
  resetChips,
  resumeClock,
  setBlindConfig,
  startHand,
  type PlayerAction,
  type TournamentConfig,
  type TournamentState,
} from '@feltcircle/poker-engine';
import { resolveImport, type ImportResolution, type SeatChips } from '@feltcircle/chip-export';
import {
  AUTO_FOLD_AFTER_MS,
  DEFAULT_GAME,
  DEFAULT_SETTINGS,
  MAX_PLAYERS,
  ROOM_TTL_MS,
  cleanNickname,
  type Command,
  type ErrorCode,
  type GameId,
  type PreAction,
  type RoomLogEntry,
  type RoomMode,
  type RoomSettings,
  type RoomStatus,
  type RoomSummary,
  type RoomView,
} from '@feltcircle/game-protocol';

export interface SeatRecord {
  seat: number;
  nickname: string;
  /** Reconnection secret (online only). Never sent to other clients or exported. */
  token: string | null;
  /** Number of open connections for this seat. */
  connections: number;
  offlineSince: number | null;
  /** Auto-Fold due to disconnect timeout or host force-fold. Cleared on reconnect. */
  autoFold: boolean;
  /** Player chose to sit out (Auto-Fold until they return). */
  away: boolean;
}

/** A late joiner waiting for the host (online, after the game started). */
export interface JoinRequest {
  seat: number;
  nickname: string;
  /** Becomes the seat token once approved. */
  token: string;
  at: number;
}

export interface PendingImport {
  seats: SeatChips;
  resolution: ImportResolution | null;
}

export interface RecentCommand {
  key: string;
  version: number;
}

export interface RoomState {
  schema: 1;
  id: string;
  mode: RoomMode;
  gameType: GameId;
  createdAt: number;
  /** Last meaningful activity (commands, joins). Heartbeats/reconnects do not count. */
  lastActivityAt: number;
  version: number;
  settings: RoomSettings;
  hostSeat: number | null;
  status: RoomStatus;
  paused: boolean;
  seats: Record<number, SeatRecord>;
  game: TournamentState | null;
  preActions: Record<number, PreAction>;
  /** Snapshots of `game` before each undoable step within the current hand. */
  undo: TournamentState[];
  pendingImport: PendingImport | null;
  requests: Record<number, JoinRequest>;
  /** Seats claiming "I won!" in the current showdown. */
  claims: number[];
  log: RoomLogEntry[];
  recent: RecentCommand[];
}

const MAX_REQUESTS = MAX_PLAYERS;

/** Fill fields added after a room was first stored (rooms persisted by an older version). */
export function normalizeRoom(state: RoomState): RoomState {
  const s = state as RoomState & Partial<Pick<RoomState, 'gameType' | 'requests' | 'claims'>>;
  if (s.gameType && s.requests && s.claims) return state;
  return { ...state, gameType: s.gameType ?? DEFAULT_GAME, requests: s.requests ?? {}, claims: s.claims ?? [] };
}

/** Who is issuing a command. Local Mode uses `{ local: true }`: host + acts for any seat. */
export interface Actor {
  seat: number | null;
  local?: boolean;
}

export class RoomError extends Error {
  constructor(public readonly code: ErrorCode | string) {
    super(code);
    this.name = 'RoomError';
  }
}

const MAX_UNDO = 30;
const MAX_LOG = 100;
const MAX_RECENT = 200;

const clone = <T>(v: T): T => structuredClone(v);

export function expiresAt(state: RoomState): number | null {
  return state.mode === 'online' ? state.lastActivityAt + ROOM_TTL_MS : null;
}

export function isExpired(state: RoomState, now: number): boolean {
  const e = expiresAt(state);
  return e !== null && now >= e;
}

export function occupiedSeats(state: RoomState): number[] {
  return Object.keys(state.seats)
    .map(Number)
    .sort((a, b) => a - b);
}

function log(state: RoomState, now: number, seat: number | null, code: string, params?: RoomLogEntry['params']) {
  state.log.push(params ? { at: now, seat, code, params } : { at: now, seat, code });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

// ---------------------------------------------------------------------------
// Creation and seating
// ---------------------------------------------------------------------------

export interface CreateOnlineRoomOptions {
  id: string;
  gameType?: GameId;
  settings?: Partial<RoomSettings>;
  hostNickname?: string;
  hostToken: string;
  now: number;
}

export function createOnlineRoom(opts: CreateOnlineRoomOptions): RoomState {
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };
  const state = baseRoom(opts.id, 'online', settings, opts.now);
  if (opts.gameType) state.gameType = opts.gameType;
  state.seats[1] = newSeat(1, cleanNickname(opts.hostNickname ?? ''), opts.hostToken, 0);
  state.seats[1].offlineSince = opts.now;
  state.hostSeat = 1;
  log(state, opts.now, 1, 'created');
  return state;
}

export interface CreateLocalRoomOptions {
  settings?: Partial<RoomSettings>;
  players: { seat: number; nickname?: string }[];
  /** Optional imported chip distribution (seat → chips). */
  chips?: SeatChips;
  now: number;
}

export function createLocalRoom(opts: CreateLocalRoomOptions): RoomState {
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };
  const maxSeat = Math.max(...opts.players.map((p) => p.seat));
  settings.maxPlayers = Math.max(settings.maxPlayers, maxSeat);
  const state = baseRoom('LOCAL', 'local', settings, opts.now);
  for (const p of opts.players) state.seats[p.seat] = newSeat(p.seat, cleanNickname(p.nickname ?? ''), null, 1);
  if (opts.chips) state.pendingImport = { seats: { ...opts.chips }, resolution: { missing: 'zero' } };
  return state;
}

function baseRoom(id: string, mode: RoomMode, settings: RoomSettings, now: number): RoomState {
  return {
    schema: 1,
    id,
    mode,
    gameType: DEFAULT_GAME,
    createdAt: now,
    lastActivityAt: now,
    version: 1,
    settings,
    hostSeat: null,
    status: 'lobby',
    paused: false,
    seats: {},
    game: null,
    preActions: {},
    undo: [],
    pendingImport: null,
    requests: {},
    claims: [],
    log: [],
    recent: [],
  };
}

function newSeat(seat: number, nickname: string, token: string | null, connections: number): SeatRecord {
  return { seat, nickname, token, connections, offlineSince: null, autoFold: false, away: false };
}

export function seatForToken(state: RoomState, token: string | undefined | null): number | null {
  if (!token) return null;
  for (const s of Object.values(state.seats)) if (s.token && s.token === token) return s.seat;
  return null;
}

/** Seat of a pending late-join request made with this token. */
export function requestForToken(state: RoomState, token: string | undefined | null): number | null {
  if (!token) return null;
  for (const r of Object.values(state.requests)) if (r.token === token) return r.seat;
  return null;
}

function seatUnavailable(state: RoomState, seat: number): boolean {
  return !!state.seats[seat] || !!state.requests[seat];
}

/**
 * Late join (online, game already started): reserve a free seat and wait for
 * the host to approve it and choose the starting chips.
 */
export function requestSeat(state0: RoomState, seat: number, nickname: string, token: string, now: number): RoomState {
  if (!Number.isInteger(seat) || seat < 1 || seat > state0.settings.maxPlayers) throw new RoomError('INVALID_SEAT');
  if (state0.status === 'lobby') throw new RoomError('NOT_ALLOWED');
  if (seatUnavailable(state0, seat)) throw new RoomError('SEAT_TAKEN');
  if (Object.keys(state0.requests).length >= MAX_REQUESTS) throw new RoomError('ROOM_FULL');
  const state = clone(state0);
  const name = cleanNickname(nickname);
  state.requests[seat] = { seat, nickname: name, token, at: now };
  log(state, now, null, 'joinRequested', { seat, name: name || `#${seat}` });
  state.version++;
  state.lastActivityAt = now;
  return state;
}

/**
 * Seat a player (online). A seat that is occupied but offline may be taken
 * over (e.g. the player switched phones); the old reconnection token stops working.
 */
export function joinSeat(
  state0: RoomState,
  seat: number,
  nickname: string,
  token: string,
  now: number,
  takeover = false,
): RoomState {
  if (!Number.isInteger(seat) || seat < 1 || seat > state0.settings.maxPlayers) throw new RoomError('INVALID_SEAT');
  const state = clone(state0);
  const existing = state.seats[seat];
  if (existing) {
    if (!takeover || existing.connections > 0) throw new RoomError('SEAT_TAKEN');
    existing.token = token;
    if (nickname) existing.nickname = cleanNickname(nickname);
    log(state, now, seat, 'takeover');
  } else {
    if (state.status !== 'lobby') throw new RoomError('GAME_STARTED');
    if (state.requests[seat]) throw new RoomError('SEAT_TAKEN');
    if (occupiedSeats(state).length >= state.settings.maxPlayers) throw new RoomError('ROOM_FULL');
    state.seats[seat] = newSeat(seat, cleanNickname(nickname), token, 0);
    state.seats[seat].offlineSince = now;
    log(state, now, seat, 'joined');
  }
  state.version++;
  state.lastActivityAt = now;
  return state;
}

// ---------------------------------------------------------------------------
// Connections (online)
// ---------------------------------------------------------------------------

export function connectSeat(state0: RoomState, seat: number, now: number): RoomState {
  const state = clone(state0);
  const s = state.seats[seat];
  if (!s) return state0;
  s.connections++;
  s.offlineSince = null;
  s.autoFold = false;
  state.version++;
  void now;
  return state;
}

export function disconnectSeat(state0: RoomState, seat: number, now: number): RoomState {
  const state = clone(state0);
  const s = state.seats[seat];
  if (!s) return state0;
  s.connections = Math.max(0, s.connections - 1);
  if (s.connections === 0) s.offlineSince = now;
  state.version++;
  return state;
}

/** Re-sync connection counters with the sockets that actually exist (after restart/hibernation). */
export function reconcileConnections(state0: RoomState, live: Record<number, number>, now: number): RoomState {
  let changed = false;
  const state = clone(state0);
  for (const s of Object.values(state.seats)) {
    const c = live[s.seat] ?? 0;
    if (c === s.connections) continue;
    changed = true;
    if (c === 0) s.offlineSince = now;
    else {
      s.offlineSince = null;
      s.autoFold = false;
    }
    s.connections = c;
  }
  if (!changed) return state0;
  state.version++;
  return state;
}

/** Next time `tick` needs to run (auto-fold deadlines, expiry). */
export function nextWakeAt(state: RoomState): number | null {
  if (state.mode !== 'online') return null;
  let at = expiresAt(state)!;
  for (const s of Object.values(state.seats)) {
    if (s.connections === 0 && s.offlineSince !== null && !s.autoFold) at = Math.min(at, s.offlineSince + AUTO_FOLD_AFTER_MS);
  }
  return at;
}

export interface TickResult {
  state: RoomState;
  changed: boolean;
  expired: boolean;
}

/** Server-side timers: enable Auto-Fold for players disconnected ≥ 30 s and run automatic actions. */
export function tick(state0: RoomState, now: number): TickResult {
  if (isExpired(state0, now)) return { state: state0, changed: false, expired: true };
  if (state0.mode !== 'online') return { state: state0, changed: false, expired: false };
  const state = clone(state0);
  let changed = false;
  for (const s of Object.values(state.seats)) {
    if (s.connections === 0 && s.offlineSince !== null && !s.autoFold && now - s.offlineSince >= AUTO_FOLD_AFTER_MS) {
      s.autoFold = true;
      delete state.preActions[s.seat];
      log(state, now, s.seat, 'autoFoldOn');
      changed = true;
    }
  }
  if (!changed) return { state: state0, changed: false, expired: false };
  runAutomation(state, now);
  state.version++;
  return { state, changed: true, expired: false };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface CommandResult {
  state: RoomState;
  ok: boolean;
  error?: string;
  /** The room should be deleted (host request). */
  deleted?: boolean;
  /** True when this exact command id was already processed (idempotent replay). */
  duplicate?: boolean;
  /**
   * Set when the command renumbered the seats (game start): waiting-room seat →
   * in-game seat. Backends must rebind live connections with it before
   * broadcasting the new state.
   */
  seatMap?: Record<number, number>;
}

function errorCode(e: unknown): string {
  if (e instanceof RoomError || e instanceof EngineError) return e.code;
  return 'INTERNAL';
}

/**
 * Apply a command atomically: either the whole command (plus any automatic
 * follow-up actions) is applied and the version increments, or nothing changes.
 * With a `commandId`, repeated submissions are ignored (idempotency).
 */
export function applyCommand(state0: RoomState, actor: Actor, cmd: Command, now: number, commandId?: string): CommandResult {
  const key = commandId ? `${actor.local ? 'L' : (actor.seat ?? '-')}:${commandId}` : null;
  if (key && state0.recent.some((r) => r.key === key)) return { state: state0, ok: true, duplicate: true };
  const state = clone(state0);
  let deleted = false;
  const out: ExecuteOutput = {};
  try {
    deleted = execute(state, actor, cmd, now, out) === 'deleted';
    runAutomation(state, now);
    syncClaims(state);
  } catch (e) {
    if (!(e instanceof RoomError || e instanceof EngineError)) throw e;
    return { state: state0, ok: false, error: errorCode(e) };
  }
  state.version++;
  state.lastActivityAt = now;
  if (key) {
    // After a renumbering, a retried command (e.g. after a reconnect) arrives from the sender's new seat.
    const moved = out.seatMap && !actor.local && actor.seat !== null ? out.seatMap[actor.seat] : undefined;
    state.recent.push({ key: moved !== undefined ? `${moved}:${commandId}` : key, version: state.version });
    if (state.recent.length > MAX_RECENT) state.recent.splice(0, state.recent.length - MAX_RECENT);
  }
  return out.seatMap ? { state, ok: true, deleted, seatMap: out.seatMap } : { state, ok: true, deleted };
}

interface ExecuteOutput {
  seatMap?: Record<number, number>;
}

// ---------------------------------------------------------------------------
// Seat renumbering (waiting room → game)
// ---------------------------------------------------------------------------

/**
 * Consecutive in-game seat numbers for the occupied waiting-room seats:
 * the lowest occupied seat becomes 1 and the rest follow clockwise
 * (ascending seat order), e.g. {1, 2, 4, 6} → {1→1, 2→2, 4→3, 6→4}.
 */
export function seatRenumbering(occupied: readonly number[]): Record<number, number> {
  const map: Record<number, number> = {};
  [...occupied].sort((a, b) => a - b).forEach((seat, i) => (map[seat] = i + 1));
  return map;
}

/** Log params that hold seat numbers (other numeric params are chips, levels, …). */
const SEAT_PARAMS: Record<string, readonly string[]> = {
  joinRequested: ['seat'],
  joinApproved: ['seat'],
  joinRejected: ['seat'],
  chipsAdjusted: ['seat'],
  hostClaimed: ['from'],
  hostTransferred: ['from', 'to'],
  forceFold: ['seat'],
  removed: ['seat'],
};

/**
 * Move every seat-based reference in the room to the new numbering, in place.
 * Seat records keep their identity (nickname, token, connection state), so
 * reconnecting players resolve to their new seat through their token.
 * History entries about players who are no longer seated are dropped, since
 * their old seat numbers would now name someone else.
 */
function applySeatMap(state: RoomState, map: Record<number, number>) {
  const has = (seat: number) => Object.prototype.hasOwnProperty.call(map, seat);
  const seats: Record<number, SeatRecord> = {};
  for (const rec of Object.values(state.seats)) {
    const to = map[rec.seat];
    seats[to] = { ...rec, seat: to };
  }
  state.seats = seats;
  if (state.hostSeat !== null) state.hostSeat = has(state.hostSeat) ? map[state.hostSeat] : null;
  const preActions: RoomState['preActions'] = {};
  for (const [k, v] of Object.entries(state.preActions)) if (has(Number(k))) preActions[map[Number(k)]] = v;
  state.preActions = preActions;
  state.claims = state.claims.filter(has).map((seat) => map[seat]);
  // `requests` needs no mapping: late-join requests cannot exist in the waiting
  // room (requestSeat refuses there and host:newGame turns them into seats).
  // Idempotency keys are "<seat>:<commandId>"; keep them attached to the same player.
  state.recent = state.recent.flatMap((r) => {
    const i = r.key.indexOf(':');
    const seat = Number(r.key.slice(0, i));
    if (!Number.isInteger(seat)) return [r];
    return has(seat) ? [{ ...r, key: `${map[seat]}${r.key.slice(i)}` }] : [];
  });
  const history: RoomLogEntry[] = [];
  for (const e of state.log) {
    if (e.seat !== null && !has(e.seat)) continue;
    const keys = SEAT_PARAMS[e.code] ?? [];
    // `from: 0` in hostTransferred means "no previous host"; it is not a seat.
    const seatParam = (k: string) => {
      const v = e.params?.[k];
      return typeof v === 'number' && v !== 0 ? v : null;
    };
    if (keys.some((k) => seatParam(k) !== null && !has(seatParam(k)!))) continue;
    const entry: RoomLogEntry = { ...e, seat: e.seat === null ? null : map[e.seat] };
    if (e.params) {
      const params = { ...e.params };
      for (const k of keys) {
        const v = seatParam(k);
        if (v !== null) params[k] = map[v];
      }
      entry.params = params;
    }
    history.push(entry);
  }
  state.log = history;
}

function isHost(state: RoomState, actor: Actor) {
  return actor.local === true || (actor.seat !== null && actor.seat === state.hostSeat);
}

function requireHost(state: RoomState, actor: Actor) {
  if (!isHost(state, actor)) throw new RoomError('NOT_HOST');
}

function requireSeated(state: RoomState, actor: Actor): number {
  if (actor.seat === null || !state.seats[actor.seat]) throw new RoomError('NOT_SEATED');
  return actor.seat;
}

function requireGame(state: RoomState): TournamentState {
  if (state.status !== 'playing' || !state.game) throw new RoomError('NOT_ALLOWED');
  return state.game;
}

function requireRunning(state: RoomState): TournamentState {
  const g = requireGame(state);
  if (state.paused) throw new RoomError('PAUSED');
  return g;
}

function pushUndo(state: RoomState) {
  if (!state.game) return;
  state.undo.push(clone(state.game));
  if (state.undo.length > MAX_UNDO) state.undo.shift();
}

function betweenHands(g: TournamentState) {
  return !g.hand || g.hand.phase === 'complete';
}

function configFromSettings(s: RoomSettings, players: number): TournamentConfig {
  return defaultConfig({
    sb: s.sb,
    bb: s.bb,
    startingChips: s.startingChips,
    progression: s.progression,
    levelMinutes: s.levelMinutes,
    playersPerLevel: playersPerLevelFor(players),
  });
}

/** Claims only exist during a showdown and only for players still contesting a pot. */
function syncClaims(state: RoomState) {
  const h = state.game?.hand;
  if (!h || h.phase !== 'showdown') {
    state.claims = [];
    return;
  }
  const contesting = new Set(currentPots(h).flatMap((p) => p.eligible));
  state.claims = state.claims.filter((s) => contesting.has(s));
}

/** Keep the room status in step with the tournament (a finished game can be revived by adding chips). */
function syncStatus(state: RoomState) {
  const g = state.game;
  if (!g || state.status === 'lobby') return;
  state.status = g.finished ? 'finished' : 'playing';
}

/** Seat a command targets: Local Mode may name any seat; online players only their own. */
function targetSeat(state: RoomState, actor: Actor, requested: number | undefined): number {
  if (actor.local) {
    if (requested === undefined || !state.seats[requested]) throw new RoomError('INVALID_SEAT');
    return requested;
  }
  const own = requireSeated(state, actor);
  if (requested !== undefined && requested !== own) throw new RoomError('NOT_ALLOWED');
  return own;
}

function afterGameChange(state: RoomState) {
  const g = state.game;
  if (!g) return;
  if (g.hand && g.hand.phase === 'complete') state.preActions = {};
  if (g.finished) state.status = 'finished';
}

/** Seat a player in the room and, when a game exists, give them chips for the next hand. */
function addSeatWithChips(state: RoomState, seat: number, nickname: string, token: string | null, chips: number, now: number) {
  state.seats[seat] = newSeat(seat, cleanNickname(nickname), token, state.mode === 'local' ? 1 : 0);
  if (state.mode === 'online') state.seats[seat].offlineSince = now;
  if (state.game && state.status !== 'lobby') {
    state.game = seatPlayer(state.game, seat, chips);
    syncStatus(state);
  }
}

function execute(state: RoomState, actor: Actor, cmd: Command, now: number, out: ExecuteOutput = {}): void | 'deleted' {
  const actorSeat = actor.local ? null : actor.seat;
  switch (cmd.type) {
    case 'act': {
      const g = requireRunning(state);
      const seat = actor.local ? (cmd.seat ?? g.hand?.toAct ?? -1) : requireSeated(state, actor);
      if (!g.hand) throw new EngineError('NO_HAND');
      const before = clone(g);
      state.game = applyAction(g, seat, cmd.action as PlayerAction);
      state.undo.push(before);
      if (state.undo.length > MAX_UNDO) state.undo.shift();
      delete state.preActions[seat];
      afterGameChange(state);
      return;
    }
    case 'setPreAction': {
      const seat = requireSeated(state, actor);
      if (cmd.preAction === null) {
        delete state.preActions[seat];
        return;
      }
      const g = requireGame(state);
      const h = g.hand;
      const me = h?.seats.find((s) => s.seat === seat);
      if (!h || (h.phase !== 'betting' && h.phase !== 'street-complete') || !me || me.folded || me.allIn) {
        throw new RoomError('NOT_ALLOWED');
      }
      if (h.phase === 'betting' && h.toAct === seat) throw new RoomError('NOT_ALLOWED');
      state.preActions[seat] = cmd.preAction;
      return;
    }
    case 'setNickname': {
      const seat = targetSeat(state, actor, cmd.seat);
      state.seats[seat].nickname = cleanNickname(cmd.nickname);
      return;
    }
    case 'setAway': {
      const seat = targetSeat(state, actor, cmd.seat);
      const s = state.seats[seat];
      s.away = cmd.away;
      if (!cmd.away && (state.mode === 'local' || s.connections > 0)) s.autoFold = false;
      if (cmd.away) delete state.preActions[seat];
      log(state, now, seat, cmd.away ? 'awayOn' : 'awayOff');
      return;
    }
    case 'leaveSeat': {
      const seat = requireSeated(state, actor);
      if (state.status !== 'lobby' || seat === state.hostSeat) throw new RoomError('NOT_ALLOWED');
      delete state.seats[seat];
      log(state, now, seat, 'left');
      return;
    }
    case 'claim': {
      const seat = targetSeat(state, actor, cmd.seat);
      const h = requireGame(state).hand;
      if (!h || h.phase !== 'showdown') throw new EngineError('WRONG_PHASE');
      if (!currentPots(h).some((p) => p.eligible.includes(seat))) throw new RoomError('NOT_ELIGIBLE');
      const has = state.claims.includes(seat);
      if (cmd.won === has) return;
      state.claims = cmd.won ? [...state.claims, seat].sort((a, b) => a - b) : state.claims.filter((s) => s !== seat);
      log(state, now, seat, cmd.won ? 'claimed' : 'claimWithdrawn');
      return;
    }
    case 'muck': {
      const seat = targetSeat(state, actor, cmd.seat);
      const g = requireGame(state);
      pushUndo(state);
      state.game = muck(g, seat);
      state.claims = state.claims.filter((s) => s !== seat);
      log(state, now, seat, 'mucked');
      afterGameChange(state);
      return;
    }
    case 'host:approveJoin': {
      requireHost(state, actor);
      const req = state.requests[cmd.seat];
      if (!req) throw new RoomError('INVALID_SEAT');
      if (cmd.seat > state.settings.maxPlayers || state.seats[cmd.seat]) throw new RoomError('INVALID_SEAT');
      delete state.requests[cmd.seat];
      addSeatWithChips(state, cmd.seat, req.nickname, req.token, cmd.chips, now);
      log(state, now, actorSeat, 'joinApproved', { seat: cmd.seat, chips: cmd.chips });
      return;
    }
    case 'host:rejectJoin': {
      requireHost(state, actor);
      if (!state.requests[cmd.seat]) throw new RoomError('INVALID_SEAT');
      delete state.requests[cmd.seat];
      log(state, now, actorSeat, 'joinRejected', { seat: cmd.seat });
      return;
    }
    case 'host:addPlayer': {
      requireHost(state, actor);
      if (state.mode !== 'local') throw new RoomError('NOT_ALLOWED');
      if (seatUnavailable(state, cmd.seat)) throw new RoomError('SEAT_TAKEN');
      state.settings.maxPlayers = Math.max(state.settings.maxPlayers, cmd.seat);
      addSeatWithChips(state, cmd.seat, cmd.nickname, null, cmd.chips, now);
      log(state, now, actorSeat, 'joinApproved', { seat: cmd.seat, chips: cmd.chips });
      return;
    }
    case 'host:setChips': {
      requireHost(state, actor);
      const g = state.game;
      if (!g || state.status === 'lobby' || !state.seats[cmd.seat]) throw new RoomError('NOT_ALLOWED');
      if (!betweenHands(g)) throw new EngineError('HAND_IN_PROGRESS');
      const from = g.chips[cmd.seat] ?? 0;
      if (from === cmd.chips) return;
      pushUndo(state);
      // `from === cmd.chips` returned above, so a seat that never played gets chips > 0 here.
      state.game = g.seats.includes(cmd.seat) ? setSeatChips(g, cmd.seat, cmd.chips) : seatPlayer(g, cmd.seat, cmd.chips);
      syncStatus(state);
      log(state, now, actorSeat, 'chipsAdjusted', { seat: cmd.seat, from, to: cmd.chips });
      return;
    }
    case 'claimHost': {
      if (state.mode !== 'online') throw new RoomError('NOT_ALLOWED');
      const seat = requireSeated(state, actor);
      if (seat === state.hostSeat) throw new RoomError('ALREADY_HOST');
      const host = state.hostSeat !== null ? state.seats[state.hostSeat] : undefined;
      if (host && host.connections > 0) throw new RoomError('HOST_CONNECTED');
      const from = state.hostSeat;
      state.hostSeat = seat;
      log(state, now, seat, 'hostClaimed', from !== null ? { from } : undefined);
      return;
    }
    case 'host:start': {
      requireHost(state, actor);
      if (state.status !== 'lobby') throw new RoomError('NOT_ALLOWED');
      const seats = occupiedSeats(state);
      if (seats.length < 2) throw new EngineError('NOT_ENOUGH_PLAYERS');
      let chips: SeatChips = {};
      if (state.pendingImport) {
        const r = resolveImport(state.pendingImport.seats, seats, state.settings.startingChips, state.pendingImport.resolution);
        if (!r.ok) throw new RoomError('RESOLUTION_REQUIRED');
        chips = r.chips;
      } else {
        for (const s of seats) chips[s] = state.settings.startingChips;
      }
      if (Object.values(chips).filter((c) => c > 0).length < 2) throw new RoomError('IMPORT_NEEDS_TWO');
      const chosenDealer = cmd.dealerSeat !== undefined && chips[cmd.dealerSeat] > 0 ? cmd.dealerSeat : undefined;
      // Close the gaps once, atomically with the start: waiting-room seats
      // {1, 2, 4, 6} play as {1, 2, 3, 4}, in the same clockwise order.
      const map = seatRenumbering(seats);
      const renumbered: SeatChips = {};
      for (const [k, c] of Object.entries(chips)) renumbered[map[Number(k)]] = c;
      chips = renumbered;
      const dealer = chosenDealer !== undefined ? map[chosenDealer] : undefined;
      applySeatMap(state, map);
      if (Object.entries(map).some(([from, to]) => Number(from) !== to)) {
        out.seatMap = map;
        log(state, now, null, 'seatsRenumbered');
      }
      const players = Object.values(chips).filter((c) => c > 0).length;
      const t = createTournament({ config: configFromSettings(state.settings, players), chips, now, firstDealer: dealer });
      state.game = startHand(t, now);
      state.status = 'playing';
      state.paused = false;
      state.undo = [];
      state.preActions = {};
      state.pendingImport = null;
      log(state, now, actorSeat === null ? null : (map[actorSeat] ?? null), 'started');
      return;
    }
    case 'host:pause': {
      requireHost(state, actor);
      const g = requireGame(state);
      if (state.paused) return;
      state.paused = true;
      state.game = pauseClock(g, now);
      log(state, now, actorSeat, 'paused');
      return;
    }
    case 'host:resume': {
      requireHost(state, actor);
      const g = requireGame(state);
      if (!state.paused) return;
      state.paused = false;
      state.game = resumeClock(g, now);
      log(state, now, actorSeat, 'resumed');
      return;
    }
    case 'host:advance': {
      requireHost(state, actor);
      const g = requireRunning(state);
      pushUndo(state);
      state.game = advanceStreet(g);
      log(state, now, actorSeat, 'advanced', { street: state.game.hand!.phase === 'showdown' ? 'showdown' : state.game.hand!.street });
      return;
    }
    case 'host:award': {
      requireHost(state, actor);
      const g = requireRunning(state);
      pushUndo(state);
      state.game = awardPots(g, cmd.winners);
      log(state, now, actorSeat, 'awarded', { hand: g.hand!.number });
      afterGameChange(state);
      return;
    }
    case 'host:nextHand': {
      requireHost(state, actor);
      const g = requireRunning(state);
      if (!betweenHands(g)) throw new EngineError('HAND_IN_PROGRESS');
      state.game = startHand(g, now);
      state.undo = [];
      state.preActions = {};
      state.claims = [];
      return;
    }
    case 'host:undo': {
      requireHost(state, actor);
      if (!state.game || state.status === 'lobby') throw new RoomError('NOT_ALLOWED');
      const prev = state.undo.pop();
      if (!prev) throw new RoomError('NOTHING_TO_UNDO');
      state.game = prev;
      state.preActions = {};
      state.claims = [];
      state.status = prev.finished ? 'finished' : 'playing';
      log(state, now, actorSeat, 'undo');
      return;
    }
    case 'host:setBlinds': {
      requireHost(state, actor);
      const b = cmd.blinds;
      Object.assign(state.settings, b);
      if (state.game && state.status !== 'lobby') {
        const g = state.game;
        const config = {
          ...g.config,
          levels: generateLevels(b.sb, b.bb),
          progression: b.progression,
          levelMinutes: b.levelMinutes,
          playersPerLevel: playersPerLevelFor(liveSeats(g).length),
        };
        const next = setBlindConfig(g, config);
        // New schedule starts now from the remaining field; applies from the next hand.
        next.levelIndex = 0;
        next.startedAt = now;
        next.pausedMs = 0;
        next.pausedAt = state.paused ? now : null;
        next.startPlayerCount = liveSeats(next).length;
        state.game = next;
      }
      log(state, now, actorSeat, 'blindsChanged', { sb: b.sb, bb: b.bb });
      return;
    }
    case 'host:setSettings': {
      requireHost(state, actor);
      const patch = cmd.settings;
      // During a game only the table size (for late joiners) and the default language may change.
      const inGameOk = Object.keys(patch).every((k) => k === 'defaultLanguage' || k === 'maxPlayers');
      if (state.status !== 'lobby' && !inGameOk) throw new RoomError('GAME_STARTED');
      const merged = { ...state.settings, ...patch };
      if (merged.sb >= merged.bb) throw new RoomError('INVALID_SETTINGS');
      const highest = Math.max(0, ...occupiedSeats(state), ...Object.keys(state.requests).map(Number));
      if (merged.maxPlayers < highest) throw new RoomError('INVALID_SETTINGS');
      state.settings = merged;
      return;
    }
    case 'host:transfer': {
      requireHost(state, actor);
      if (state.mode !== 'online') throw new RoomError('NOT_ALLOWED');
      if (!state.seats[cmd.seat] || cmd.seat === state.hostSeat) throw new RoomError('INVALID_SEAT');
      const from = state.hostSeat;
      state.hostSeat = cmd.seat;
      log(state, now, actorSeat, 'hostTransferred', { from: from ?? 0, to: cmd.seat });
      return;
    }
    case 'host:forceFold': {
      requireHost(state, actor);
      const s = state.seats[cmd.seat];
      if (!s) throw new RoomError('INVALID_SEAT');
      if (state.mode === 'online' && s.connections > 0) throw new RoomError('PLAYER_ONLINE');
      s.autoFold = true;
      delete state.preActions[cmd.seat];
      log(state, now, actorSeat, 'forceFold', { seat: cmd.seat });
      return;
    }
    case 'host:removeSeat': {
      requireHost(state, actor);
      if (state.status !== 'lobby') throw new RoomError('GAME_STARTED');
      if (!state.seats[cmd.seat] || cmd.seat === state.hostSeat) throw new RoomError('INVALID_SEAT');
      delete state.seats[cmd.seat];
      log(state, now, actorSeat, 'removed', { seat: cmd.seat });
      return;
    }
    case 'host:import': {
      requireHost(state, actor);
      if (state.status === 'lobby') {
        const r = resolveImport(cmd.seats, occupiedSeats(state), state.settings.startingChips, cmd.resolution);
        if (!r.ok) throw new RoomError('RESOLUTION_REQUIRED');
        if (Object.values(r.chips).filter((c) => c > 0).length < 2) throw new RoomError('IMPORT_NEEDS_TWO');
        state.pendingImport = { seats: { ...cmd.seats }, resolution: cmd.resolution };
        log(state, now, actorSeat, 'importStaged');
        return;
      }
      const g = state.game;
      if (!g) throw new RoomError('NOT_ALLOWED');
      if (!betweenHands(g)) throw new EngineError('HAND_IN_PROGRESS');
      const r = resolveImport(cmd.seats, g.seats, state.settings.startingChips, cmd.resolution);
      if (!r.ok) throw new RoomError('RESOLUTION_REQUIRED');
      if (Object.values(r.chips).filter((c) => c > 0).length < 2) throw new RoomError('IMPORT_NEEDS_TWO');
      state.game = resetChips(g, r.chips);
      syncStatus(state);
      state.undo = [];
      state.preActions = {};
      log(state, now, actorSeat, 'chipReset');
      return;
    }
    case 'host:clearImport': {
      requireHost(state, actor);
      state.pendingImport = null;
      return;
    }
    case 'host:endGame': {
      requireHost(state, actor);
      if (state.status !== 'playing') throw new RoomError('NOT_ALLOWED');
      state.status = 'finished';
      if (state.game && state.game.hand && state.game.hand.phase !== 'complete') {
        // Unfinished hand is voided: confirmed balances are those before the hand.
        state.game = { ...state.game, hand: null };
      }
      state.preActions = {};
      state.undo = [];
      log(state, now, actorSeat, 'ended');
      return;
    }
    case 'host:newGame': {
      requireHost(state, actor);
      if (state.status === 'playing' && state.game && !betweenHands(state.game)) throw new EngineError('HAND_IN_PROGRESS');
      state.status = 'lobby';
      state.game = null;
      state.undo = [];
      state.preActions = {};
      state.paused = false;
      state.pendingImport = null;
      state.claims = [];
      for (const req of Object.values(state.requests)) {
        if (!state.seats[req.seat] && req.seat <= state.settings.maxPlayers) addSeatWithChips(state, req.seat, req.nickname, req.token, 0, now);
      }
      state.requests = {};
      log(state, now, actorSeat, 'newGame');
      return;
    }
    case 'host:deleteRoom': {
      requireHost(state, actor);
      return 'deleted';
    }
  }
}

/** Seats that currently act automatically. */
export function isAutoFold(state: RoomState, seat: number): boolean {
  const s = state.seats[seat];
  return !!s && (s.away || (state.mode === 'online' && s.autoFold));
}

/**
 * Execute automatic actions for whoever must act: Auto-Fold (disconnected,
 * forced or away) takes precedence over pre-actions and folds. All-in players
 * never act, so they keep their pot eligibility. Pre-actions are executed at
 * most once.
 */
export function runAutomation(state: RoomState, now: number): void {
  for (let guard = 0; guard < 100; guard++) {
    const g = state.game;
    const h = g?.hand;
    if (!g || !h || h.phase !== 'betting' || h.toAct === null || state.paused || state.status !== 'playing') return;
    const seat = h.toAct;
    const legal = legalActions(h, seat)!;
    let action: PlayerAction | null = null;
    if (isAutoFold(state, seat)) {
      action = { type: 'fold' };
      delete state.preActions[seat];
    } else {
      const pre = state.preActions[seat];
      if (pre === 'fold') action = { type: 'fold' };
      else if (pre === 'checkfold') action = legal.canCheck ? { type: 'check' } : { type: 'fold' };
      else if (pre === 'callany') action = legal.canCheck ? { type: 'check' } : { type: 'call' };
      delete state.preActions[seat];
    }
    if (!action) return;
    state.game = applyAction(g, seat, action, { auto: true });
    afterGameChange(state);
  }
  void now;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function toView(state: RoomState, viewerSeat: number | null, now: number): RoomView {
  const g = state.game;
  const hand = g?.hand;
  return {
    id: state.id,
    mode: state.mode,
    gameType: state.gameType,
    version: state.version,
    status: state.status,
    paused: state.paused,
    settings: { ...state.settings },
    hostSeat: state.hostSeat,
    seats: occupiedSeats(state).map((n) => {
      const s = state.seats[n];
      return {
        seat: n,
        nickname: s.nickname,
        connected: state.mode === 'local' || s.connections > 0,
        offlineSince: state.mode === 'local' ? null : s.offlineSince,
        autoFold: isAutoFold(state, n),
        away: s.away,
      };
    }),
    game: g ?? null,
    pots: !hand || hand.phase === 'complete' ? [] : hand.phase === 'betting' ? displayPots(hand.seats) : currentPots(hand),
    nextLevelInMs: g && state.status === 'playing' ? msUntilNextLevel(g, now) : null,
    myPreAction: viewerSeat !== null ? (state.preActions[viewerSeat] ?? null) : null,
    viewerSeat,
    canUndo: state.undo.length > 0,
    pendingImport: state.pendingImport ? resolvePendingForView(state) : null,
    joinRequests: Object.values(state.requests)
      .map((r) => ({ seat: r.seat, nickname: r.nickname, at: r.at }))
      .sort((a, b) => a.seat - b.seat),
    claims: [...state.claims],
    log: state.log.slice(-50),
    expiresAt: expiresAt(state),
    serverTime: now,
  };
}

function resolvePendingForView(state: RoomState): SeatChips {
  const p = state.pendingImport!;
  const r = resolveImport(p.seats, occupiedSeats(state), state.settings.startingChips, p.resolution ?? { missing: 'starting' });
  return r.ok ? r.chips : p.seats;
}

export function toSummary(state: RoomState): RoomSummary {
  return {
    id: state.id,
    gameType: state.gameType,
    status: state.status,
    maxPlayers: state.settings.maxPlayers,
    occupied: occupiedSeats(state).map((n) => ({
      seat: n,
      nickname: state.seats[n].nickname,
      connected: state.seats[n].connections > 0,
    })),
    requested: Object.keys(state.requests).map(Number),
  };
}

/**
 * Confirmed balances for chip export. `TournamentState.chips` is only updated
 * when a hand completes, so during a hand this is the start-of-hand distribution.
 */
export function confirmedChips(game: TournamentState | null | undefined): SeatChips | null {
  if (!game) return null;
  const out: SeatChips = {};
  for (const s of game.seats) out[s] = game.chips[s] ?? 0;
  return out;
}
