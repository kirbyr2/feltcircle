import { PING_FRAME, PONG_FRAME, type GameId, type RoomSettings } from '@feltcircle/game-protocol';
import {
  RoomRuntime,
  createOnlineRoom,
  isExpired,
  toSummary,
  type Connection,
  type RoomHost,
  type RoomState,
} from '@feltcircle/room-core';
import type { Env } from './env.js';

const STORAGE_KEY = 'room';
const MAX_SOCKETS = 40;

interface Attachment {
  seat: number | null;
}

/** Adapts a hibernatable WebSocket; the bound seat lives in the socket attachment. */
class CfConnection implements Connection {
  constructor(readonly ws: WebSocket) {}
  send(text: string) {
    this.ws.send(text);
  }
  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }
  getSeat(): number | null {
    return (this.ws.deserializeAttachment() as Attachment | null)?.seat ?? null;
  }
  setSeat(seat: number | null) {
    this.ws.serializeAttachment({ seat } satisfies Attachment);
  }
}

/**
 * One Durable Object per room. State is stored in SQLite-backed DO storage,
 * sockets use the Hibernation API, and expiry/auto-fold use DO Alarms.
 * All game logic lives in the shared RoomRuntime.
 */
export class RoomDurableObject {
  private runtime: RoomRuntime | null = null;
  private loading: Promise<RoomRuntime | null> | null = null;
  private wrappers = new WeakMap<WebSocket, CfConnection>();

  constructor(
    private readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {
    // Heartbeats are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

  private conn(ws: WebSocket): CfConnection {
    let c = this.wrappers.get(ws);
    if (!c) {
      c = new CfConnection(ws);
      this.wrappers.set(ws, c);
    }
    return c;
  }

  private host(): RoomHost {
    return {
      connections: () => this.ctx.getWebSockets().map((ws) => this.conn(ws)),
      save: (state: RoomState) => this.ctx.storage.put(STORAGE_KEY, state),
      remove: async () => {
        this.runtime = null;
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
      },
      setWake: async (at) => {
        if (at === null) await this.ctx.storage.deleteAlarm();
        else await this.ctx.storage.setAlarm(at);
      },
      now: () => Date.now(),
    };
  }

  private async load(): Promise<RoomRuntime | null> {
    if (this.runtime && !this.runtime.isDeleted) return this.runtime;
    if (!this.loading) {
      this.loading = (async () => {
        const state = await this.ctx.storage.get<RoomState>(STORAGE_KEY);
        if (!state) return null;
        if (isExpired(state, Date.now())) {
          await this.ctx.storage.deleteAll();
          return null;
        }
        this.runtime = await RoomRuntime.open(state, this.host());
        return this.runtime;
      })().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/internal/create' && request.method === 'POST') {
      const body = (await request.json()) as { id: string; game: GameId; settings: RoomSettings; nickname: string; token: string };
      const existing = await this.load();
      if (existing) return new Response('exists', { status: 409 });
      const state = createOnlineRoom({ id: body.id, gameType: body.game, settings: body.settings, hostNickname: body.nickname, hostToken: body.token, now: Date.now() });
      await this.ctx.storage.put(STORAGE_KEY, state);
      this.runtime = await RoomRuntime.open(state, this.host());
      return new Response('created', { status: 201 });
    }
    if (url.pathname === '/internal/summary') {
      const rt = await this.load();
      if (!rt) return Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 });
      return Response.json(toSummary(rt.state));
    }
    if (url.pathname === '/internal/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      const [clientSide, serverSide] = Object.values(pair);
      const rt = await this.load();
      if (!rt || this.ctx.getWebSockets().length >= MAX_SOCKETS) {
        serverSide.accept();
        serverSide.send(JSON.stringify({ t: 'error', error: rt ? 'ROOM_FULL' : 'ROOM_NOT_FOUND' }));
        serverSide.close(4404, 'room not found');
        return new Response(null, { status: 101, webSocket: clientSide });
      }
      this.accept(serverSide);
      return new Response(null, { status: 101, webSocket: clientSide });
    }
    return new Response('not found', { status: 404 });
  }

  /** Register a server-side socket with the hibernation API. */
  accept(ws: WebSocket) {
    this.ctx.acceptWebSocket(ws);
    ws.serializeAttachment({ seat: null } satisfies Attachment);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const rt = await this.load();
    if (!rt) {
      ws.send(JSON.stringify({ t: 'error', error: 'ROOM_NOT_FOUND' }));
      ws.close(4404, 'room not found');
      return;
    }
    await rt.onMessage(this.conn(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const rt = await this.load();
    if (rt) await rt.onClose(this.conn(ws));
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const rt = await this.load();
    if (rt) await rt.onClose(this.conn(ws));
  }

  async alarm(): Promise<void> {
    const rt = await this.load();
    if (!rt) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await rt.onWake();
  }
}

/** Per-IP fixed-window counter for room creation (no KV/D1 needed). */
export class RateLimiterDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? '30');
    const windowMs = 60 * 60_000;
    const now = Date.now();
    const rec = (await this.ctx.storage.get<{ start: number; count: number }>('w')) ?? { start: now, count: 0 };
    if (now - rec.start >= windowMs) {
      rec.start = now;
      rec.count = 0;
    }
    rec.count++;
    await this.ctx.storage.put('w', rec);
    await this.ctx.storage.setAlarm(rec.start + windowMs);
    return new Response(null, { status: rec.count > limit ? 429 : 204 });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
