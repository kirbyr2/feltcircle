import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MAX_MESSAGE_BYTES,
  ROOM_PATH,
  corsHeaders,
  isValidRoomId,
  makeCapabilities,
  parseCreateRoomBody,
  wsRoomFromUrl,
} from '@feltcircle/game-protocol';
import {
  RateLimiter,
  RoomRuntime,
  createOnlineRoom,
  generateUniqueRoomId,
  isExpired,
  randomToken,
  toSummary,
  type Connection,
  type RoomState,
} from '@feltcircle/room-core';
import { RoomDb } from './db.js';
import type { ServerConfig } from './config.js';

export const SERVER_VERSION = '1.0.0';
const MAX_CONNECTIONS_PER_ROOM = 40;
const WS_PING_MS = 25_000;

class NodeConnection implements Connection {
  seat: number | null = null;
  alive = true;
  constructor(readonly ws: WebSocket) {}
  send(text: string) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(text);
  }
  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }
  getSeat() {
    return this.seat;
  }
  setSeat(seat: number | null) {
    this.seat = seat;
  }
}

interface LoadedRoom {
  runtime: RoomRuntime;
  conns: Set<NodeConnection>;
  timer: NodeJS.Timeout | null;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
  /** For tests: advance logic as if timers fired. */
  rooms: Map<string, Promise<LoadedRoom | null>>;
  db: RoomDb;
}

export interface ServerOptions {
  now?: () => number;
  log?: (...args: unknown[]) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export async function startServer(config: ServerConfig, opts: ServerOptions = {}): Promise<RunningServer> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), ...a));
  const db = new RoomDb(config.dbFile);
  const createLimiter = new RateLimiter(config.roomCreateLimit, 60 * 60_000);
  const rooms = new Map<string, Promise<LoadedRoom | null>>();

  function loadRoom(id: string): Promise<LoadedRoom | null> {
    const existing = rooms.get(id);
    if (existing) return existing;
    const p = (async () => {
      const state = db.get(id, now());
      if (!state) return null;
      const entry: LoadedRoom = { runtime: null as unknown as RoomRuntime, conns: new Set(), timer: null };
      entry.runtime = await RoomRuntime.open(state, {
        connections: () => [...entry.conns],
        save: (s: RoomState) => db.put(s, now()),
        remove: () => {
          db.delete(id);
          rooms.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
        },
        setWake: (at) => {
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = null;
          if (at === null) return;
          entry.timer = setTimeout(() => void entry.runtime.onWake().catch((e) => log('wake error', id, e)), Math.max(0, Math.min(at - now(), 2 ** 31 - 1)));
          entry.timer.unref?.();
        },
        now,
      });
      return entry;
    })();
    rooms.set(id, p);
    p.then((r) => {
      if (!r) rooms.delete(id);
    }).catch(() => rooms.delete(id));
    return p;
  }

  function clientIp(req: http.IncomingMessage): string {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
      const real = req.headers['x-real-ip'];
      if (typeof real === 'string' && real) return real;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: http.IncomingMessage, limit = 8192): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error('too large');
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
    if (!config.staticDir) return false;
    const root = config.staticDir;
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) return false;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (path.extname(rel)) return false;
      file = path.join(root, 'index.html'); // SPA fallback
      if (!fs.existsSync(file)) return false;
    }
    const ext = path.extname(file);
    const base = path.basename(file);
    const immutable = /\/assets\//.test(file.replaceAll('\\', '/'));
    const noCache = base === 'sw.js' || base === 'index.html' || base === 'config.json' || ext === '.webmanifest';
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : noCache ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = corsHeaders((req.headers.origin as string) ?? null, config.corsOrigins);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          res.end();
          return;
        }
        if (url.pathname === '/api/capabilities' && req.method === 'GET') {
          return json(res, 200, makeCapabilities('node', SERVER_VERSION), cors);
        }
        if (url.pathname === '/api/rooms' && req.method === 'POST') {
          if (!createLimiter.allow(clientIp(req), now())) return json(res, 429, { error: 'RATE_LIMITED' }, cors);
          if (db.activeCount(now()) >= config.maxRooms) return json(res, 503, { error: 'RATE_LIMITED' }, cors);
          let body: unknown;
          try {
            body = await readBody(req);
          } catch {
            return json(res, 400, { error: 'INVALID_MESSAGE' }, cors);
          }
          const parsed = parseCreateRoomBody(body);
          if (!parsed.ok) return json(res, 400, { error: parsed.error }, cors);
          const { game, settings, nickname } = parsed.body;
          const id = await generateUniqueRoomId((candidate) => rooms.has(candidate) || db.exists(candidate, now()));
          const token = randomToken();
          const state = createOnlineRoom({ id, gameType: game, settings, hostNickname: nickname, hostToken: token, now: now() });
          db.put(state, now());
          log('room created', id);
          return json(res, 201, { roomId: id, token, seat: 1 }, cors);
        }
        const m = ROOM_PATH.exec(url.pathname);
        if (m && !m[2] && req.method === 'GET') {
          const room = await loadRoom(m[1]);
          if (!room || room.runtime.isDeleted || isExpired(room.runtime.state, now())) return json(res, 404, { error: 'ROOM_NOT_FOUND' }, cors);
          return json(res, 200, toSummary(room.runtime.state), cors);
        }
        return json(res, 404, { error: 'NOT_FOUND' }, cors);
      }
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (e) {
      log('request error', e);
      if (!res.headersSent) json(res, 500, { error: 'INTERNAL' }, cors);
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const roomId = wsRoomFromUrl(url);
    if (!roomId) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes('*') && !config.corsOrigins.includes(origin) && !sameOrigin(req, origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    let room: LoadedRoom | null = null;
    try {
      room = await loadRoom(roomId);
    } catch (e) {
      log('load error', e);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!room || room.runtime.isDeleted || room.conns.size >= MAX_CONNECTIONS_PER_ROOM) {
        ws.send(JSON.stringify({ t: 'error', error: room ? 'ROOM_FULL' : 'ROOM_NOT_FOUND' }));
        ws.close(4404, 'room not found');
        return;
      }
      const entry = room;
      const conn = new NodeConnection(ws);
      entry.conns.add(conn);
      // Serialize message handling per room.
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        void entry.runtime.onMessage(conn, data.toString()).catch((e) => log('message error', e));
      });
      ws.on('pong', () => {
        conn.alive = true;
      });
      ws.on('close', () => {
        entry.conns.delete(conn);
        void entry.runtime.onClose(conn).catch((e) => log('close error', e));
      });
      ws.on('error', () => ws.terminate());
    });
  });

  function sameOrigin(req: http.IncomingMessage, origin: string) {
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  // Heartbeat: terminate sockets that stop answering pings.
  const pinger = setInterval(() => {
    for (const p of rooms.values()) {
      void p.then((r) => {
        if (!r) return;
        for (const c of r.conns) {
          if (!c.alive) {
            c.ws.terminate();
            continue;
          }
          c.alive = false;
          try {
            c.ws.ping();
          } catch {
            /* ignore */
          }
        }
      });
    }
  }, WS_PING_MS);
  pinger.unref();

  // Room expiry: unloaded rooms are swept from SQLite; loaded rooms expire via their own timers.
  const sweeper = setInterval(() => {
    try {
      const n = db.deleteExpired(now());
      if (n) log(`deleted ${n} expired room(s)`);
    } catch (e) {
      log('cleanup error', e);
    }
  }, config.cleanupIntervalMs);
  sweeper.unref();
  db.deleteExpired(now());

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;

  async function close() {
    clearInterval(pinger);
    clearInterval(sweeper);
    for (const p of rooms.values()) {
      const r = await p.catch(() => null);
      if (!r) continue;
      if (r.timer) clearTimeout(r.timer);
      // 1012 = service restart: clients reconnect automatically.
      for (const c of r.conns) c.ws.close(1012, 'server restart');
    }
    wss.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    db.close();
  }

  return { port, close, rooms, db };
}
