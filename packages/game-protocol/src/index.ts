import type { BlindProgression, PlayerAction, Pot, TournamentState } from '@feltcircle/poker-engine';
import type { ImportResolution, SeatChips } from '@feltcircle/chip-export';
import { isValidChips, isValidSeat } from '@feltcircle/chip-export';

export const APP_ID = 'feltcircle';
/**
 * Bump on incompatible protocol changes; older clients are then asked to reload.
 * 2: seats are renumbered when the game starts and `RoomView.viewerSeat` tells
 *    each client its (possibly new) seat. Pre-action `check` (distinct from
 *    `checkfold`), `setPreAction.hand` and `RoomView.preActionNotice`.
 * 3: streets advance automatically (`reveal` phase, `host:showdown`), showdown
 *    declarations (`declare`, `RoomView.showdown`) replace `claim`/`muck`.
 */
export const PROTOCOL_VERSION = 3;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
export const MAX_NICKNAME = 20;
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Seconds a player may be disconnected before Auto-Fold is enabled. */
export const AUTO_FOLD_AFTER_MS = 30_000;
/**
 * Showdown: when exactly one player declares Win (single pot, no Tie, no
 * conflict), every other contender is folded automatically this long after
 * the declaration unless they select Win or Tie first.
 */
export const SHOWDOWN_FOLD_MS = 5_000;
/** Rooms are kept for 24 hours after the last meaningful activity. */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** Exact heartbeat frame (Cloudflare auto-response requires byte-identical text). */
export const PING_FRAME = '{"t":"ping"}';
export const PONG_FRAME = '{"t":"pong"}';

// ---------------------------------------------------------------------------
// Game catalog
// ---------------------------------------------------------------------------

/** Stable game identifiers. Only games marked `available` can be played. */
export const GAME_CATALOG = [
  { id: 'texas-holdem', available: true },
  { id: 'riichi-mahjong', available: false },
] as const;
export type GameId = (typeof GAME_CATALOG)[number]['id'];
export const DEFAULT_GAME: GameId = 'texas-holdem';
export const SUPPORTED_GAMES: readonly GameId[] = GAME_CATALOG.filter((g) => g.available).map((g) => g.id);

export function isSupportedGame(x: unknown): x is GameId {
  return typeof x === 'string' && (SUPPORTED_GAMES as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface Capabilities {
  app: typeof APP_ID;
  protocolVersion: number;
  features: { multiplayer: boolean; websocket: boolean; persistence: boolean };
  /** Games this backend can host. */
  games?: string[];
  server?: { platform: string; version: string };
}

export function makeCapabilities(platform: string, version = '1.0.0'): Capabilities {
  return {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    features: { multiplayer: true, websocket: true, persistence: true },
    games: [...SUPPORTED_GAMES],
    server: { platform, version },
  };
}

/** True when a capabilities response describes a backend this client can use for multiplayer. */
export function isCompatibleBackend(x: unknown): x is Capabilities {
  if (!x || typeof x !== 'object') return false;
  const c = x as Partial<Capabilities>;
  return (
    c.app === APP_ID &&
    c.protocolVersion === PROTOCOL_VERSION &&
    !!c.features &&
    c.features.multiplayer === true &&
    c.features.websocket === true
  );
}

// ---------------------------------------------------------------------------
// Room settings and views
// ---------------------------------------------------------------------------

export const LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface RoomSettings {
  maxPlayers: number;
  startingChips: number;
  sb: number;
  bb: number;
  progression: BlindProgression;
  levelMinutes: number;
  defaultLanguage: Language;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  maxPlayers: 6,
  startingChips: 2000,
  sb: 10,
  bb: 20,
  progression: 'hybrid',
  levelMinutes: 15,
  defaultLanguage: 'en',
};

/**
 * Pre-selected automatic action. `check` and `checkfold` are distinct values:
 * Check never folds or calls (it is cancelled when a call becomes necessary),
 * Check/Fold folds. Which ones are on offer depends on the amount owed
 * (`preActionChoices` in the poker engine).
 */
export type PreAction = 'fold' | 'checkfold' | 'check' | 'callany';
export const PRE_ACTIONS: readonly PreAction[] = ['fold', 'checkfold', 'check', 'callany'];
/** Why the viewer's pre-action was removed without being executed. */
export type PreActionNotice = 'checkCanceled';
export type RoomStatus = 'lobby' | 'playing' | 'finished';
export type RoomMode = 'online' | 'local';

export interface SeatView {
  seat: number;
  nickname: string;
  connected: boolean;
  offlineSince: number | null;
  /** Auto-Fold active (disconnected > 30 s, forced by host, or sitting out). */
  autoFold: boolean;
  /** Player chose to sit out (local mode toggle / own choice online). */
  away: boolean;
}

export interface RoomLogEntry {
  at: number;
  /** Seat that performed the action (null for system). */
  seat: number | null;
  code: string;
  params?: Record<string, string | number>;
}

export interface JoinRequestView {
  seat: number;
  nickname: string;
  at: number;
}

export interface RoomView {
  id: string;
  mode: RoomMode;
  gameType: GameId;
  version: number;
  status: RoomStatus;
  paused: boolean;
  settings: RoomSettings;
  hostSeat: number | null;
  seats: SeatView[];
  game: TournamentState | null;
  pots: Pot[];
  nextLevelInMs: number | null;
  /** The viewer's own pending pre-action (other players' pre-actions are private). */
  myPreAction: PreAction | null;
  /** Set when the viewer's Check was cancelled because a call became necessary. */
  preActionNotice?: PreActionNotice | null;
  canUndo: boolean;
  /**
   * The seat this view was rendered for (null for spectators/unseated clients
   * and Local Mode). Seats are renumbered once when the game starts, so clients
   * take their own seat number from here rather than remembering it.
   */
  viewerSeat?: number | null;
  pendingImport: SeatChips | null;
  /** Late-join requests waiting for the host (online, after the game started). */
  joinRequests: JoinRequestView[];
  /** Showdown declarations and the automatic-fold countdown (null outside the showdown). */
  showdown: ShowdownView | null;
  log: RoomLogEntry[];
  expiresAt: number | null;
  serverTime: number;
}

/** A player's showdown declaration. Folding is final and shown through the hand (`mucked`). */
export type Declaration = 'win' | 'tie';

export interface ShowdownView {
  /** Declarations of players still contesting the pot(s). */
  declarations: Record<number, Declaration>;
  /**
   * Host judgment required: automatic settlement is off for this showdown
   * (side pots, a Tie, several Win claims, or a cancelled countdown).
   */
  manual: boolean;
  /** Side pots exist: the host settles every pot. */
  sidePots: boolean;
  /** Sole Win claimant while the countdown runs. */
  claimant: number | null;
  /** Server time (ms) at which the other contenders fold automatically; null when no countdown runs. */
  deadline: number | null;
}

export interface RoomSummary {
  id: string;
  gameType: GameId;
  status: RoomStatus;
  maxPlayers: number;
  occupied: { seat: number; nickname: string; connected: boolean }[];
  /** Seats reserved by pending late-join requests. */
  requested: number[];
}

// ---------------------------------------------------------------------------
// Commands (client → room)
// ---------------------------------------------------------------------------

export interface BlindSettings {
  sb: number;
  bb: number;
  progression: BlindProgression;
  levelMinutes: number;
}

export type Command =
  /** `seat` is only used in Local Mode, where one device acts for every seat. */
  | { type: 'act'; action: PlayerAction; seat?: number }
  /**
   * `hand`: the hand number the client saw when choosing. A selection that
   * arrives for another hand (late, resent after a reconnect) is rejected.
   */
  | { type: 'setPreAction'; preAction: PreAction | null; hand?: number }
  | { type: 'setNickname'; nickname: string; seat?: number }
  | { type: 'setAway'; away: boolean; seat?: number }
  | { type: 'leaveSeat' }
  | { type: 'claimHost' }
  /**
   * Showdown declaration: Win, Tie, Fold (final: gives up the right to win this
   * hand's pots), or null to withdraw Win/Tie. `hand` guards against messages
   * that arrive after the hand moved on.
   */
  | { type: 'declare'; declaration: Declaration | 'fold' | null; seat?: number; hand?: number }
  | { type: 'host:start'; dealerSeat?: number }
  | { type: 'host:pause' }
  | { type: 'host:resume' }
  /** All cards dealt and hands revealed: begin the showdown. */
  | { type: 'host:showdown' }
  | { type: 'host:award'; winners: number[][] }
  | { type: 'host:nextHand' }
  | { type: 'host:undo' }
  | { type: 'host:setBlinds'; blinds: BlindSettings }
  | { type: 'host:setSettings'; settings: Partial<RoomSettings> }
  | { type: 'host:transfer'; seat: number }
  | { type: 'host:forceFold'; seat: number }
  | { type: 'host:removeSeat'; seat: number }
  | { type: 'host:approveJoin'; seat: number; chips: number }
  | { type: 'host:rejectJoin'; seat: number }
  /** Administrative balance correction between hands. */
  | { type: 'host:setChips'; seat: number; chips: number }
  /** Local Mode: add a player at the table (dealt in from the next hand). */
  | { type: 'host:addPlayer'; seat: number; nickname: string; chips: number }
  | { type: 'host:import'; seats: SeatChips; resolution: ImportResolution | null }
  | { type: 'host:clearImport' }
  | { type: 'host:endGame' }
  | { type: 'host:newGame' }
  | { type: 'host:deleteRoom' };

export type CommandType = Command['type'];

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: 'hello'; token?: string; protocolVersion: number }
  | { t: 'join'; seat: number; nickname: string; takeover?: boolean }
  | { t: 'cmd'; id: string; cmd: Command }
  | { t: 'ping' };

export type ServerMessage =
  /** `pendingSeat`: this client's late-join request still awaiting the host. */
  | { t: 'welcome'; seat: number | null; room: RoomView; pendingSeat?: number | null }
  /** `pending`: the seat was requested (game already running) and needs host approval. */
  | { t: 'joined'; seat: number; token: string; pending?: boolean }
  | { t: 'state'; room: RoomView }
  | { t: 'ack'; id: string; ok: true; version: number }
  | { t: 'ack'; id: string; ok: false; error: string }
  | { t: 'error'; error: string }
  | { t: 'deleted'; reason: 'host' | 'expired' }
  | { t: 'pong' };

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'SEAT_TAKEN'
  | 'INVALID_SEAT'
  | 'GAME_STARTED'
  | 'NOT_SEATED'
  | 'NOT_HOST'
  | 'HOST_CONNECTED'
  | 'ALREADY_HOST'
  | 'PLAYER_ONLINE'
  | 'NOT_ALLOWED'
  | 'PAUSED'
  | 'NOTHING_TO_UNDO'
  | 'IMPORT_NEEDS_TWO'
  | 'RESOLUTION_REQUIRED'
  | 'INVALID_MESSAGE'
  | 'INVALID_SETTINGS'
  | 'PROTOCOL_MISMATCH'
  | 'RATE_LIMITED'
  | 'BAD_TOKEN'
  | 'UNSUPPORTED_GAME'
  | 'NOT_ELIGIBLE'
  /** The pre-action is not on offer right now (e.g. Check while a call is required) or the hand has moved on. */
  | 'PRE_ACTION_UNAVAILABLE'
  /** A message meant for an earlier hand. */
  | 'HAND_CHANGED';

// ---------------------------------------------------------------------------
// Validation (never trust the wire)
// ---------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isInt = (x: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
const isStr = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const isSeat = (x: unknown): x is number => isInt(x, 1, MAX_PLAYERS);

/** Trim and strip control characters from nicknames. */
export function cleanNickname(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, '').trim().slice(0, MAX_NICKNAME);
}

function validAction(a: unknown): PlayerAction | null {
  if (!isObj(a)) return null;
  switch (a.type) {
    case 'fold':
    case 'check':
    case 'call':
    case 'allin':
      return { type: a.type };
    case 'bet':
    case 'raise':
      return isInt(a.amount, 1) ? { type: a.type, amount: a.amount } : null;
    default:
      return null;
  }
}

const PROGRESSIONS = ['hybrid', 'time', 'players', 'fixed'];
export const MAX_CHIPS = 1e9;

function validBlinds(b: unknown): BlindSettings | null {
  if (!isObj(b)) return null;
  if (!isInt(b.sb, 1, MAX_CHIPS) || !isInt(b.bb, 1, MAX_CHIPS) || b.sb >= b.bb) return null;
  if (!PROGRESSIONS.includes(b.progression as string)) return null;
  if (!isInt(b.levelMinutes, 1, 1440)) return null;
  return { sb: b.sb, bb: b.bb, progression: b.progression as BlindProgression, levelMinutes: b.levelMinutes };
}

/** Validate a partial settings object; returns null when any provided field is invalid. */
export function validSettingsPatch(s: unknown): Partial<RoomSettings> | null {
  if (!isObj(s)) return null;
  const out: Partial<RoomSettings> = {};
  for (const [k, v] of Object.entries(s)) {
    switch (k) {
      case 'maxPlayers':
        if (!isInt(v, MIN_PLAYERS, MAX_PLAYERS)) return null;
        out.maxPlayers = v;
        break;
      case 'startingChips':
        if (!isInt(v, 1, 1e9)) return null;
        out.startingChips = v;
        break;
      case 'sb':
      case 'bb':
        if (!isInt(v, 1, 1e9)) return null;
        out[k] = v;
        break;
      case 'progression':
        if (!PROGRESSIONS.includes(v as string)) return null;
        out.progression = v as BlindProgression;
        break;
      case 'levelMinutes':
        if (!isInt(v, 1, 1440)) return null;
        out.levelMinutes = v;
        break;
      case 'defaultLanguage':
        if (!(LANGUAGES as readonly string[]).includes(v as string)) return null;
        out.defaultLanguage = v as Language;
        break;
      default:
        return null;
    }
  }
  return out;
}

export function validFullSettings(s: unknown): RoomSettings | null {
  const patch = validSettingsPatch(s);
  if (!patch) return null;
  const merged = { ...DEFAULT_SETTINGS, ...patch };
  if (merged.sb >= merged.bb) return null;
  return merged;
}

function validSeatChips(x: unknown): SeatChips | null {
  if (!isObj(x)) return null;
  const out: SeatChips = {};
  const entries = Object.entries(x);
  if (entries.length === 0 || entries.length > MAX_PLAYERS) return null;
  for (const [k, v] of entries) {
    if (!/^\d+$/.test(k) || !isValidSeat(Number(k)) || !isValidChips(v)) return null;
    out[Number(k)] = v;
  }
  return out;
}

export function validateCommand(c: unknown): Command | null {
  if (!isObj(c) || typeof c.type !== 'string') return null;
  const optSeat = (x: unknown) => x === undefined || isSeat(x);
  switch (c.type) {
    case 'act': {
      const action = validAction(c.action);
      if (!action || !optSeat(c.seat)) return null;
      return c.seat === undefined ? { type: 'act', action } : { type: 'act', action, seat: c.seat as number };
    }
    case 'setPreAction':
      if (c.preAction !== null && !PRE_ACTIONS.includes(c.preAction as PreAction)) return null;
      if (c.hand !== undefined && !isInt(c.hand, 1)) return null;
      return { type: 'setPreAction', preAction: c.preAction as PreAction | null, ...(c.hand !== undefined ? { hand: c.hand as number } : {}) };
    case 'setNickname':
      if (!isStr(c.nickname, 100) || !optSeat(c.seat)) return null;
      return { type: 'setNickname', nickname: cleanNickname(c.nickname), ...(c.seat !== undefined ? { seat: c.seat as number } : {}) };
    case 'setAway':
      if (typeof c.away !== 'boolean' || !optSeat(c.seat)) return null;
      return { type: 'setAway', away: c.away, ...(c.seat !== undefined ? { seat: c.seat as number } : {}) };
    case 'host:start':
      if (!optSeat(c.dealerSeat)) return null;
      return c.dealerSeat === undefined ? { type: 'host:start' } : { type: 'host:start', dealerSeat: c.dealerSeat as number };
    case 'host:award': {
      if (!Array.isArray(c.winners) || c.winners.length === 0 || c.winners.length > MAX_PLAYERS) return null;
      const winners: number[][] = [];
      for (const w of c.winners) {
        if (!Array.isArray(w) || w.length === 0 || w.length > MAX_PLAYERS || !w.every(isSeat)) return null;
        winners.push([...w]);
      }
      return { type: 'host:award', winners };
    }
    case 'host:setBlinds': {
      const blinds = validBlinds(c.blinds);
      return blinds ? { type: 'host:setBlinds', blinds } : null;
    }
    case 'host:setSettings': {
      const settings = validSettingsPatch(c.settings);
      return settings ? { type: 'host:setSettings', settings } : null;
    }
    case 'host:transfer':
    case 'host:forceFold':
    case 'host:removeSeat':
    case 'host:rejectJoin':
      return isSeat(c.seat) ? { type: c.type, seat: c.seat } : null;
    case 'host:approveJoin':
      return isSeat(c.seat) && isInt(c.chips, 1, MAX_CHIPS) ? { type: c.type, seat: c.seat, chips: c.chips } : null;
    case 'host:setChips':
      return isSeat(c.seat) && isInt(c.chips, 0, MAX_CHIPS) ? { type: c.type, seat: c.seat, chips: c.chips } : null;
    case 'host:addPlayer':
      if (!isSeat(c.seat) || !isInt(c.chips, 1, MAX_CHIPS) || !isStr(c.nickname, 100)) return null;
      return { type: c.type, seat: c.seat, chips: c.chips, nickname: cleanNickname(c.nickname) };
    case 'declare': {
      if (c.declaration !== null && !['win', 'tie', 'fold'].includes(c.declaration as string)) return null;
      if (!optSeat(c.seat) || (c.hand !== undefined && !isInt(c.hand, 1))) return null;
      return {
        type: 'declare',
        declaration: c.declaration as Declaration | 'fold' | null,
        ...(c.seat !== undefined ? { seat: c.seat as number } : {}),
        ...(c.hand !== undefined ? { hand: c.hand as number } : {}),
      };
    }
    case 'host:import': {
      const seats = validSeatChips(c.seats);
      if (!seats) return null;
      let resolution: ImportResolution | null = null;
      if (c.resolution !== null && c.resolution !== undefined) {
        if (!isObj(c.resolution) || !['starting', 'zero'].includes(c.resolution.missing as string)) return null;
        resolution = { missing: c.resolution.missing as 'starting' | 'zero' };
      }
      return { type: 'host:import', seats, resolution };
    }
    case 'leaveSeat':
    case 'claimHost':
    case 'host:pause':
    case 'host:resume':
    case 'host:showdown':
    case 'host:nextHand':
    case 'host:undo':
    case 'host:clearImport':
    case 'host:endGame':
    case 'host:newGame':
    case 'host:deleteRoom':
      return { type: c.type };
    default:
      return null;
  }
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'ping':
      return { t: 'ping' };
    case 'hello':
      if (!isInt(m.protocolVersion, 0, 1000)) return null;
      if (m.token !== undefined && !(isStr(m.token, 128) && /^[A-Za-z0-9_-]+$/.test(m.token))) return null;
      return { t: 'hello', protocolVersion: m.protocolVersion, ...(m.token ? { token: m.token as string } : {}) };
    case 'join':
      if (!isSeat(m.seat) || !isStr(m.nickname, 100)) return null;
      if (m.takeover !== undefined && typeof m.takeover !== 'boolean') return null;
      return { t: 'join', seat: m.seat, nickname: cleanNickname(m.nickname), takeover: m.takeover === true };
    case 'cmd': {
      if (!isStr(m.id, 64) || !/^[A-Za-z0-9_-]{1,64}$/.test(m.id)) return null;
      const cmd = validateCommand(m.cmd);
      return cmd ? { t: 'cmd', id: m.id, cmd } : null;
    }
    default:
      return null;
  }
}

/** Server messages are trusted less strictly by the client, but still sanity-checked. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const m = JSON.parse(raw);
    if (!isObj(m) || typeof m.t !== 'string') return null;
    return m as unknown as ServerMessage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Room IDs
// ---------------------------------------------------------------------------

/** Uppercase letters and digits, without easily confused characters (0/O, 1/I/L). */
export const ROOM_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_ID_LENGTH = 5;

export function isValidRoomId(s: string): boolean {
  return s.length === ROOM_ID_LENGTH && [...s].every((c) => ROOM_ID_ALPHABET.includes(c));
}

/** Parse a typed room code (case-insensitive, ignores spaces/dashes). */
export function parseRoomCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return isValidRoomId(s) ? s : null;
}

// ---------------------------------------------------------------------------
// HTTP API helpers (shared by both backends)
// ---------------------------------------------------------------------------

export interface CreateRoomBody {
  game: GameId;
  settings: RoomSettings;
  nickname: string;
}

export type ParsedCreateRoom = { ok: true; body: CreateRoomBody } | { ok: false; error: 'INVALID_SETTINGS' | 'UNSUPPORTED_GAME' };

/** Validate `POST /api/rooms` bodies. `game` defaults to Texas Hold'em; other games are rejected. */
export function parseCreateRoomBody(x: unknown): ParsedCreateRoom {
  if (!isObj(x)) return { ok: false, error: 'INVALID_SETTINGS' };
  const game = x.game ?? DEFAULT_GAME;
  if (!isSupportedGame(game)) return { ok: false, error: 'UNSUPPORTED_GAME' };
  const settings = validFullSettings(x.settings ?? {});
  if (!settings) return { ok: false, error: 'INVALID_SETTINGS' };
  if (x.nickname !== undefined && !isStr(x.nickname, 100)) return { ok: false, error: 'INVALID_SETTINGS' };
  return { ok: true, body: { game, settings, nickname: cleanNickname((x.nickname as string | undefined) ?? '') } };
}

/** CORS headers for a request origin given an allow-list (`*` allows any). */
export function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> {
  const h: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  if (allowed.includes('*')) h['access-control-allow-origin'] = '*';
  else if (origin && allowed.includes(origin)) h['access-control-allow-origin'] = origin;
  return h;
}

export const ROOM_PATH = /^\/api\/rooms\/([A-Z0-9]{5})(\/ws)?\/?$/;

/** WebSocket endpoint: `/ws?room=ABCDE` (the legacy `/api/rooms/ABCDE/ws` is also accepted). */
export const WS_PATH = '/ws';

/** Room ID of a WebSocket upgrade URL, or null when the URL is not a room socket. */
export function wsRoomFromUrl(url: URL): string | null {
  if (url.pathname === WS_PATH || url.pathname === `${WS_PATH}/`) {
    const id = (url.searchParams.get('room') ?? '').toUpperCase();
    return isValidRoomId(id) ? id : null;
  }
  const m = ROOM_PATH.exec(url.pathname);
  return m && m[2] && isValidRoomId(m[1]) ? m[1] : null;
}
