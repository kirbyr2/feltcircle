import WebSocket from 'ws';
import { ServerSession, type TokenStore, type WebSocketLike } from '@feltcircle/game-session';

export class MemoryTokens implements TokenStore {
  map = new Map<string, string>();
  get(id: string) {
    return this.map.get(id) ?? null;
  }
  set(id: string, t: string) {
    this.map.set(id, t);
  }
  remove(id: string) {
    this.map.delete(id);
  }
}

export function client(baseUrl: string, roomId: string, tokens = new MemoryTokens()) {
  const session = new ServerSession({
    baseUrl,
    roomId,
    tokens,
    createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    heartbeatMs: 1000,
    deadAfterMs: 5000,
  });
  return { session, tokens };
}

export async function waitFor(cond: () => boolean, ms = 5000, label = 'condition') {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
