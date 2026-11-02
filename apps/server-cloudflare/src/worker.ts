import {
  ROOM_PATH,
  corsHeaders,
  makeCapabilities,
  parseCreateRoomBody,
  wsRoomFromUrl,
} from '@feltcircle/game-protocol';
import { generateUniqueRoomId, randomToken } from '@feltcircle/room-core';
import type { Env } from './env.js';

export { RoomDurableObject, RateLimiterDurableObject } from './room-do.js';

const VERSION = '1.0.0';

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function roomStub(env: Env, id: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(id));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const allowed = (env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(request.headers.get('origin'), allowed);

    const wsRoom = wsRoomFromUrl(url);
    if (wsRoom) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const origin = request.headers.get('origin');
      if (origin && !allowed.includes('*') && !allowed.includes(origin) && new URL(origin).host !== url.host) {
        return new Response('forbidden', { status: 403 });
      }
      return roomStub(env, wsRoom).fetch(new Request('https://room/internal/ws', request));
    }

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/api/capabilities' && request.method === 'GET') {
      return json(makeCapabilities('cloudflare', VERSION), 200, cors);
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const limiter = env.LIMITER.get(env.LIMITER.idFromName(`ip:${ip}`));
      const lim = await limiter.fetch(`https://limiter/?limit=${encodeURIComponent(env.ROOM_CREATE_LIMIT ?? '30')}`);
      if (lim.status === 429) return json({ error: 'RATE_LIMITED' }, 429, cors);
      let body: unknown;
      try {
        const text = await request.text();
        if (text.length > 8192) return json({ error: 'INVALID_MESSAGE' }, 400, cors);
        body = text ? JSON.parse(text) : {};
      } catch {
        return json({ error: 'INVALID_MESSAGE' }, 400, cors);
      }
      const parsed = parseCreateRoomBody(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400, cors);
      const { game, settings, nickname } = parsed.body;
      const token = randomToken();
      let created: string | null = null;
      // Each room ID maps to its own Durable Object, which atomically refuses
      // creation when an active room already uses the ID (collision → retry).
      await generateUniqueRoomId(async (id) => {
        const res = await roomStub(env, id).fetch('https://room/internal/create', {
          method: 'POST',
          body: JSON.stringify({ id, game, settings, nickname, token }),
        });
        if (res.status === 201) {
          created = id;
          return false;
        }
        return true;
      });
      if (!created) return json({ error: 'INTERNAL' }, 500, cors);
      return json({ roomId: created, token, seat: 1 }, 201, cors);
    }

    const m = ROOM_PATH.exec(url.pathname);
    if (m && !m[2]) {
      const stub = roomStub(env, m[1]);
      if (request.method === 'GET') {
        const res = await stub.fetch('https://room/internal/summary');
        return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors } });
      }
    }
    return json({ error: 'NOT_FOUND' }, 404, cors);
  },
};
