import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '@feltcircle/game-protocol';
import {
  applyCommand,
  connectSeat,
  disconnectSeat,
  isExpired,
  joinSeat,
  nextWakeAt,
  normalizeRoom,
  reconcileConnections,
  requestForToken,
  requestSeat,
  RoomError,
  seatForToken,
  tick,
  toView,
  type RoomState,
} from './room.js';
import { randomToken } from './ids.js';

/** A client connection as seen by the runtime. Platform adapters implement this. */
export interface Connection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** Seat bound to this connection (persisted in the socket attachment on Cloudflare). */
  getSeat(): number | null;
  setSeat(seat: number | null): void;
}

/** Platform services for one room. */
export interface RoomHost {
  /** All currently open connections of this room. */
  connections(): Connection[];
  /** Persist state atomically. */
  save(state: RoomState): void | Promise<void>;
  /** Delete all persisted data of the room. */
  remove(): void | Promise<void>;
  /** Ask to be woken (call `onWake`) at the given time, or cancel with null. */
  setWake(at: number | null): void | Promise<void>;
  now(): number;
}

const MSG_LIMIT = 40; // messages per connection per 10 s

/**
 * Authoritative room server logic shared by the Node.js and Cloudflare backends:
 * validates every message, applies it to the shared room/poker engine,
 * persists the result and broadcasts per-player views.
 */
export class RoomRuntime {
  private deleted = false;
  private rate = new WeakMap<Connection, { n: number; start: number }>();

  private constructor(
    public state: RoomState,
    private readonly host: RoomHost,
  ) {}

  /** Load a room, reconcile connection counters with live sockets and schedule timers. */
  static async open(stored: RoomState, host: RoomHost): Promise<RoomRuntime> {
    const state = normalizeRoom(stored);
    const rt = new RoomRuntime(state, host);
    const live: Record<number, number> = {};
    for (const c of host.connections()) {
      const seat = c.getSeat();
      if (seat !== null) live[seat] = (live[seat] ?? 0) + 1;
    }
    const reconciled = reconcileConnections(state, live, host.now());
    if (reconciled !== state) {
      rt.state = reconciled;
      await host.save(reconciled);
    }
    await host.setWake(nextWakeAt(rt.state));
    return rt;
  }

  get isDeleted() {
    return this.deleted;
  }

  private send(conn: Connection, msg: ServerMessage) {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      /* socket already closed */
    }
  }

  broadcast() {
    const now = this.host.now();
    for (const c of this.host.connections()) {
      this.send(c, { t: 'state', room: toView(this.state, c.getSeat(), now) });
    }
  }

  private async commit(next: RoomState) {
    this.state = next;
    await this.host.save(next);
    await this.host.setWake(nextWakeAt(next));
    this.broadcast();
  }

  private allowMessage(conn: Connection, now: number) {
    const r = this.rate.get(conn);
    if (!r || now - r.start > 10_000) {
      this.rate.set(conn, { n: 1, start: now });
      return true;
    }
    r.n++;
    return r.n <= MSG_LIMIT;
  }

  async onMessage(conn: Connection, raw: unknown): Promise<void> {
    const now = this.host.now();
    if (this.deleted || isExpired(this.state, now)) {
      this.send(conn, { t: 'error', error: 'ROOM_NOT_FOUND' });
      conn.close(4404, 'room not found');
      return;
    }
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.send(conn, { t: 'error', error: 'INVALID_MESSAGE' });
      return;
    }
    if (msg.t === 'ping') {
      this.send(conn, { t: 'pong' });
      return;
    }
    if (!this.allowMessage(conn, now)) {
      if (msg.t === 'cmd') this.send(conn, { t: 'ack', id: msg.id, ok: false, error: 'RATE_LIMITED' });
      else this.send(conn, { t: 'error', error: 'RATE_LIMITED' });
      return;
    }
    switch (msg.t) {
      case 'hello':
        return this.onHello(conn, msg);
      case 'join':
        return this.onJoin(conn, msg);
      case 'cmd':
        return this.onCommand(conn, msg);
    }
  }

  private async onHello(conn: Connection, msg: Extract<ClientMessage, { t: 'hello' }>) {
    const now = this.host.now();
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.send(conn, { t: 'error', error: 'PROTOCOL_MISMATCH' });
      conn.close(4400, 'protocol mismatch');
      return;
    }
    const prev = conn.getSeat();
    const seat = seatForToken(this.state, msg.token);
    if (prev !== null && prev !== seat) {
      conn.setSeat(null);
      this.state = disconnectSeat(this.state, prev, now);
    }
    if (seat !== null && prev !== seat) {
      conn.setSeat(seat);
      this.send(conn, { t: 'welcome', seat, room: toView(this.state, seat, now) });
      await this.commit(connectSeat(this.state, seat, now));
      return;
    }
    const pendingSeat = seat === null ? requestForToken(this.state, msg.token) : null;
    if (msg.token && seat === null && pendingSeat === null) this.send(conn, { t: 'error', error: 'BAD_TOKEN' });
    this.send(conn, { t: 'welcome', seat, room: toView(this.state, seat, now), pendingSeat });
  }

  private async onJoin(conn: Connection, msg: Extract<ClientMessage, { t: 'join' }>) {
    const now = this.host.now();
    if (conn.getSeat() !== null) {
      this.send(conn, { t: 'error', error: 'NOT_ALLOWED' });
      return;
    }
    const token = randomToken();
    let next: RoomState;
    try {
      if (this.state.status !== 'lobby' && !msg.takeover) {
        // Late join: reserve the seat and wait for the host's approval.
        next = requestSeat(this.state, msg.seat, msg.nickname, token, now);
        this.send(conn, { t: 'joined', seat: msg.seat, token, pending: true });
        await this.commit(next);
        return;
      }
      next = joinSeat(this.state, msg.seat, msg.nickname, token, now, msg.takeover);
    } catch (e) {
      this.send(conn, { t: 'error', error: e instanceof RoomError ? e.code : 'INTERNAL' });
      return;
    }
    // If another socket was bound to a taken-over seat, unbind it.
    for (const c of this.host.connections()) {
      if (c !== conn && c.getSeat() === msg.seat) {
        c.setSeat(null);
        next = disconnectSeat(next, msg.seat, now);
      }
    }
    conn.setSeat(msg.seat);
    next = connectSeat(next, msg.seat, now);
    this.send(conn, { t: 'joined', seat: msg.seat, token });
    await this.commit(next);
  }

  private async onCommand(conn: Connection, msg: Extract<ClientMessage, { t: 'cmd' }>) {
    const now = this.host.now();
    const seat = conn.getSeat();
    if (seat === null) {
      this.send(conn, { t: 'ack', id: msg.id, ok: false, error: 'NOT_SEATED' });
      return;
    }
    const r = applyCommand(this.state, { seat }, msg.cmd, now, msg.id);
    if (!r.ok) {
      this.send(conn, { t: 'ack', id: msg.id, ok: false, error: r.error! });
      return;
    }
    if (r.duplicate) {
      this.send(conn, { t: 'ack', id: msg.id, ok: true, version: this.state.version });
      this.send(conn, { t: 'state', room: toView(this.state, seat, now) });
      return;
    }
    if (r.deleted) {
      this.send(conn, { t: 'ack', id: msg.id, ok: true, version: r.state.version });
      await this.destroy('host');
      return;
    }
    if (r.seatMap) this.rebindSeats(r.seatMap);
    this.send(conn, { t: 'ack', id: msg.id, ok: true, version: r.state.version });
    await this.commit(r.state);
  }

  /**
   * Seats were renumbered (game start): move every live connection to its
   * player's new seat so turn checks, views and disconnect tracking follow the
   * player. Clients learn their new number from `viewerSeat` in the next state.
   */
  private rebindSeats(map: Record<number, number>) {
    const bound = this.host.connections().map((c) => [c, c.getSeat()] as const);
    for (const [c, seat] of bound) if (seat !== null && map[seat] !== undefined && map[seat] !== seat) c.setSeat(map[seat]);
  }

  async onClose(conn: Connection): Promise<void> {
    const seat = conn.getSeat();
    if (seat === null || this.deleted) return;
    conn.setSeat(null);
    await this.commit(disconnectSeat(this.state, seat, this.host.now()));
  }

  /** Timer callback: expiry and auto-fold deadlines. */
  async onWake(): Promise<void> {
    if (this.deleted) return;
    const r = tick(this.state, this.host.now());
    if (r.expired) {
      await this.destroy('expired');
      return;
    }
    if (r.changed) await this.commit(r.state);
    else await this.host.setWake(nextWakeAt(this.state));
  }

  async destroy(reason: 'host' | 'expired') {
    this.deleted = true;
    await this.host.setWake(null);
    await this.host.remove();
    for (const c of this.host.connections()) {
      this.send(c, { t: 'deleted', reason });
      try {
        c.close(4410, reason);
      } catch {
        /* ignore */
      }
    }
  }
}
