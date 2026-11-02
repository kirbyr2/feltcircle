import {
  PING_FRAME,
  PROTOCOL_VERSION,
  WS_PATH,
  parseServerMessage,
  type ClientMessage,
  type Command,
  type RoomView,
  type ServerMessage,
} from '@feltcircle/game-protocol';
import { Emitter, randomId, type CommandOutcome, type GameSession, type SessionSnapshot } from './types.js';

/** Minimal WebSocket surface (browser WebSocket and the `ws` package both fit). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface TokenStore {
  get(roomId: string): string | null;
  set(roomId: string, token: string): void;
  remove(roomId: string): void;
}

export interface ServerSessionOptions {
  /** Backend base URL, e.g. `https://example.com` (same origin) or an external server. */
  baseUrl: string;
  roomId: string;
  tokens: TokenStore;
  createSocket: WebSocketFactory;
  heartbeatMs?: number;
  /** Close and reconnect when nothing was received for this long. */
  deadAfterMs?: number;
  commandTimeoutMs?: number;
  now?: () => number;
}

const OPEN = 1;

export function wsUrl(baseUrl: string, roomId: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/$/, '')}${WS_PATH}`;
  u.search = `?room=${encodeURIComponent(roomId)}`;
  u.hash = '';
  return u.toString();
}

interface Pending {
  resolve: (r: CommandOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Online Multiplayer client. The server is authoritative: the client only renders
 * server state and sends validated commands. Commands carry unique IDs so
 * retries are idempotent; while disconnected, commands are refused.
 */
export class ServerSession implements GameSession {
  private emitter = new Emitter();
  private ws: WebSocketLike | null = null;
  private snapshot: SessionSnapshot = {
    room: null,
    mySeat: null,
    pendingSeat: null,
    isHost: false,
    local: false,
    connection: 'connecting',
    pending: false,
    lastError: null,
    gone: null,
  };
  private pending = new Map<string, Pending>();
  private joinWaiter: { resolve: (r: CommandOutcome) => void } | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private lastSeen = 0;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly opts: ServerSessionOptions) {
    this.now = opts.now ?? Date.now;
    this.connect();
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(fn: () => void) {
    return this.emitter.subscribe(fn);
  }

  private update(patch: Partial<SessionSnapshot>) {
    const next = { ...this.snapshot, ...patch };
    next.isHost = next.room !== null && next.mySeat !== null && next.room.hostSeat === next.mySeat;
    next.pending = this.pending.size > 0;
    this.snapshot = next;
    this.emitter.emit();
  }

  private connect() {
    if (this.disposed || this.snapshot.gone) return;
    let ws: WebSocketLike;
    try {
      ws = this.opts.createSocket(wsUrl(this.opts.baseUrl, this.opts.roomId));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastSeen = this.now();
    ws.onopen = () => {
      this.lastSeen = this.now();
      this.sendHello();
    };
    ws.onmessage = (ev) => {
      this.lastSeen = this.now();
      const msg = parseServerMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg) this.onServerMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onDisconnected();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    this.startHeartbeat();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    const every = this.opts.heartbeatMs ?? 20_000;
    const dead = this.opts.deadAfterMs ?? 45_000;
    this.heartbeat = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (this.now() - this.lastSeen > dead) {
        // Half-open connection: drop it and reconnect.
        this.ws = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        this.onDisconnected();
        return;
      }
      if (ws.readyState === OPEN) ws.send(PING_FRAME);
    }, every);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private onDisconnected() {
    this.stopHeartbeat();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'DISCONNECTED' });
    }
    this.pending.clear();
    if (this.joinWaiter) {
      this.joinWaiter.resolve({ ok: false, error: 'DISCONNECTED' });
      this.joinWaiter = null;
    }
    if (this.disposed || this.snapshot.gone) return;
    this.update({ connection: 'reconnecting' });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.disposed) return;
    const delay = Math.min(10_000, 500 * 2 ** this.attempts);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Reconnect immediately (e.g. when the page becomes visible again). */
  reconnectNow() {
    if (this.disposed || this.snapshot.gone) return;
    if (this.ws && this.ws.readyState === OPEN && this.now() - this.lastSeen < (this.opts.deadAfterMs ?? 45_000)) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempts = 0;
    const old = this.ws;
    this.ws = null;
    try {
      old?.close();
    } catch {
      /* ignore */
    }
    this.connect();
  }

  private raw(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendHello() {
    const token = this.opts.tokens.get(this.opts.roomId) ?? undefined;
    this.raw({ t: 'hello', protocolVersion: PROTOCOL_VERSION, ...(token ? { token } : {}) });
  }

  private acceptRoom(room: RoomView) {
    const cur = this.snapshot.room;
    if (cur && cur.id === room.id && room.version < cur.version && this.snapshot.connection === 'online') return;
    const pendingSeat = this.snapshot.pendingSeat;
    if (pendingSeat !== null && !room.joinRequests.some((r) => r.seat === pendingSeat)) {
      if (room.seats.some((s) => s.seat === pendingSeat)) {
        // Approved by the host: bind this connection to the new seat.
        this.update({ room, pendingSeat: null });
        this.sendHello();
      } else {
        this.opts.tokens.remove(this.opts.roomId);
        this.update({ room, pendingSeat: null, lastError: { code: 'JOIN_REJECTED', at: this.now() } });
      }
      return;
    }
    this.update({ room });
  }

  private onServerMessage(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome':
        this.attempts = 0;
        this.update({ room: msg.room, mySeat: msg.seat, pendingSeat: msg.pendingSeat ?? null, connection: 'online' });
        return;
      case 'state':
        this.acceptRoom(msg.room);
        return;
      case 'joined':
        this.opts.tokens.set(this.opts.roomId, msg.token);
        this.update(msg.pending ? { pendingSeat: msg.seat } : { mySeat: msg.seat, pendingSeat: null });
        this.joinWaiter?.resolve({ ok: true });
        this.joinWaiter = null;
        return;
      case 'ack': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.ok) {
          p.resolve({ ok: true });
          this.update({});
        } else {
          p.resolve({ ok: false, error: msg.error });
          this.update({ lastError: { code: msg.error, at: this.now() } });
        }
        return;
      }
      case 'error':
        if (msg.error === 'BAD_TOKEN') {
          this.opts.tokens.remove(this.opts.roomId);
          return;
        }
        if (msg.error === 'ROOM_NOT_FOUND') {
          this.opts.tokens.remove(this.opts.roomId);
          this.update({ gone: 'notfound', connection: 'closed' });
          this.dispose();
          return;
        }
        if (this.joinWaiter) {
          this.joinWaiter.resolve({ ok: false, error: msg.error });
          this.joinWaiter = null;
        }
        this.update({ lastError: { code: msg.error, at: this.now() } });
        return;
      case 'deleted':
        this.opts.tokens.remove(this.opts.roomId);
        this.update({ gone: msg.reason, connection: 'closed' });
        this.dispose();
        return;
      case 'pong':
        return;
    }
  }

  /**
   * Take a seat in the lobby, take over an offline seat, or — once the game has
   * started — request a seat (resolves when the request is registered; the host
   * then approves it and `pendingSeat` turns into `mySeat`).
   */
  join(seat: number, nickname: string, takeover = false): Promise<CommandOutcome> {
    if (this.snapshot.connection !== 'online') return Promise.resolve({ ok: false, error: 'DISCONNECTED' });
    return new Promise((resolve) => {
      this.joinWaiter?.resolve({ ok: false, error: 'NOT_ALLOWED' });
      this.joinWaiter = { resolve };
      this.raw({ t: 'join', seat, nickname, takeover });
    });
  }

  send(cmd: Command): Promise<CommandOutcome> {
    if (this.snapshot.connection !== 'online' || !this.ws) {
      return Promise.resolve({ ok: false, error: 'DISCONNECTED' });
    }
    const id = randomId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'TIMEOUT' });
        this.update({});
      }, this.opts.commandTimeoutMs ?? 10_000);
      this.pending.set(id, { resolve, timer });
      this.update({});
      this.raw({ t: 'cmd', id, cmd });
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'bye');
    } catch {
      /* ignore */
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'DISCONNECTED' });
    }
    this.pending.clear();
  }
}
