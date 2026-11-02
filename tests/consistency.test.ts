import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from '@feltcircle/game-protocol';
import { applyCommand, createLocalRoom, type RoomState } from '@feltcircle/room-core';
import { createRoomRequest } from '@feltcircle/game-session';
import type { TournamentState } from '@feltcircle/poker-engine';
import { loadConfig } from '../apps/server-node/src/config.js';
import { startServer, type RunningServer } from '../apps/server-node/src/server.js';
import { FakeCtx, FakeSocket, installCfGlobals } from './cf-fakes.js';
import { client, MemoryTokens, waitFor } from './support.js';

installCfGlobals();
const { RoomDurableObject } = await import('../apps/server-cloudflare/src/room-do.js');

/** Late join of seat 4 with 1500 chips (Local: host adds the player; online: request + approval). */
const LATE_JOIN = 'late-join' as const;

/**
 * A realistic script: raises, a short all-in, side pots, a split pot, an
 * elimination, an administrative chip adjustment that revives the busted
 * player, a late joiner, victory claims, a claim withdrawal and a muck.
 */
const SCRIPT: Array<[number, Command] | typeof LATE_JOIN> = [
  [1, { type: 'host:start' }],
  // Hand 1: D=1 SB=2 BB=3
  [1, { type: 'act', action: { type: 'raise', amount: 60 } }],
  [2, { type: 'act', action: { type: 'call' } }],
  [3, { type: 'act', action: { type: 'raise', amount: 200 } }],
  [1, { type: 'act', action: { type: 'call' } }],
  [2, { type: 'act', action: { type: 'fold' } }],
  [1, { type: 'host:advance' }],
  [3, { type: 'act', action: { type: 'bet', amount: 300 } }],
  [1, { type: 'act', action: { type: 'raise', amount: 900 } }],
  [3, { type: 'act', action: { type: 'allin' } }],
  [1, { type: 'act', action: { type: 'call' } }],
  [1, { type: 'host:advance' }],
  [1, { type: 'host:award', winners: [[1, 3]] }],
  [1, { type: 'host:nextHand' }],
  // Hand 2: D=2 SB=3 BB=1
  [2, { type: 'act', action: { type: 'allin' } }],
  [3, { type: 'act', action: { type: 'call' } }],
  [1, { type: 'act', action: { type: 'fold' } }],
  [1, { type: 'host:advance' }],
  [1, { type: 'host:award', winners: [[3]] }],
  // Between hands: revive seat 2 and add a late joiner on seat 4.
  [1, { type: 'host:setChips', seat: 2, chips: 1000 }],
  LATE_JOIN,
  [1, { type: 'host:nextHand' }],
  // Hand 3: D=4 SB=1 BB=2
  [3, { type: 'act', action: { type: 'call' } }],
  [4, { type: 'act', action: { type: 'call' } }],
  [1, { type: 'act', action: { type: 'call' } }],
  [2, { type: 'act', action: { type: 'check' } }],
  [1, { type: 'host:advance' }],
  [1, { type: 'act', action: { type: 'bet', amount: 100 } }],
  [2, { type: 'act', action: { type: 'call' } }],
  [3, { type: 'act', action: { type: 'fold' } }],
  [4, { type: 'act', action: { type: 'call' } }],
  [1, { type: 'host:advance' }],
  [1, { type: 'act', action: { type: 'check' } }],
  [2, { type: 'act', action: { type: 'check' } }],
  [4, { type: 'act', action: { type: 'check' } }],
  [1, { type: 'host:advance' }],
  [1, { type: 'act', action: { type: 'check' } }],
  [2, { type: 'act', action: { type: 'check' } }],
  [4, { type: 'act', action: { type: 'check' } }],
  // Showdown: 2 and 4 claim, 4 withdraws, 1 mucks, host confirms 2.
  [2, { type: 'claim', won: true }],
  [4, { type: 'claim', won: true }],
  [4, { type: 'claim', won: false }],
  [1, { type: 'muck' }],
  [1, { type: 'host:award', winners: [[2]] }],
];

const PER_SEAT = new Set(['act', 'claim', 'muck']);

function normalize(g: TournamentState | null) {
  const c = structuredClone(g) as Record<string, unknown> | null;
  if (c) {
    delete c.startedAt;
    delete c.pausedAt;
    delete c.pausedMs;
  }
  return c;
}

function runLocal() {
  let s: RoomState = createLocalRoom({ players: [{ seat: 1 }, { seat: 2 }, { seat: 3 }], now: 0 });
  for (const step of SCRIPT) {
    const [seat, cmd]: [number, Command] = step === LATE_JOIN ? [1, { type: 'host:addPlayer', seat: 4, nickname: '', chips: 1500 }] : step;
    const c = PER_SEAT.has(cmd.type) ? ({ ...cmd, seat } as Command) : cmd;
    const r = applyCommand(s, { seat: null, local: true }, c, 0);
    if (!r.ok) throw new Error(`local ${cmd.type}: ${r.error}`);
    s = r.state;
  }
  return s.game;
}

let server: RunningServer;
beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cons-'));
  server = await startServer(loadConfig({ PORT: '0', DB_FILE: path.join(dir, 'db.sqlite') }), { log: () => {} });
});
afterAll(async () => server.close());

async function runNode() {
  const base = `http://127.0.0.1:${server.port}`;
  const created = await createRoomRequest(base, { settings: {}, nickname: '' });
  if (!created.ok) throw new Error(created.error);
  const id = created.room.roomId;
  const t1 = new MemoryTokens();
  t1.set(id, created.room.token);
  const c = [client(base, id, t1), client(base, id), client(base, id), client(base, id)];
  await waitFor(() => c.every((x) => x.session.getSnapshot().connection === 'online'));
  await c[1].session.join(2, '');
  await c[2].session.join(3, '');
  for (const step of SCRIPT) {
    if (step === LATE_JOIN) {
      expect((await c[3].session.join(4, '')).ok).toBe(true);
      expect((await c[0].session.send({ type: 'host:approveJoin', seat: 4, chips: 1500 })).ok).toBe(true);
      await waitFor(() => c[3].session.getSnapshot().mySeat === 4, 5000, 'late joiner seated');
      continue;
    }
    const [seat, cmd] = step;
    const r = await c[seat - 1].session.send(cmd);
    if (!r.ok) throw new Error(`node ${cmd.type}: ${r.error}`);
  }
  await waitFor(() => c[0].session.getSnapshot().room?.game?.hand?.phase === 'complete' && c[0].session.getSnapshot().room?.game?.handCount === 3);
  const game = c[0].session.getSnapshot().room!.game;
  for (const x of c) x.session.dispose();
  return game;
}

async function runCloudflare() {
  const ctx = new FakeCtx();
  let dobj = new RoomDurableObject(ctx as never, {} as never);
  const res = await dobj.fetch(
    new Request('https://room/internal/create', { method: 'POST', body: JSON.stringify({ id: 'CFTST', game: 'texas-holdem', settings: { maxPlayers: 6, startingChips: 2000, sb: 10, bb: 20, progression: 'hybrid', levelMinutes: 15, defaultLanguage: 'en' }, nickname: '', token: 'hosttoken' }) }),
  );
  expect(res.status).toBe(201);
  // creating the same id again collides
  expect((await dobj.fetch(new Request('https://room/internal/create', { method: 'POST', body: '{}' }))).status).toBe(409);
  const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket(), new FakeSocket()];
  for (const ws of sockets) dobj.accept(ws as never);
  await dobj.webSocketMessage(sockets[0] as never, JSON.stringify({ t: 'hello', protocolVersion: 1, token: 'hosttoken' }));
  await dobj.webSocketMessage(sockets[1] as never, JSON.stringify({ t: 'join', seat: 2, nickname: '' }));
  await dobj.webSocketMessage(sockets[2] as never, JSON.stringify({ t: 'join', seat: 3, nickname: '' }));
  let n = 0;
  const send = async (ws: FakeSocket, cmd: Command) => {
    n++;
    await dobj.webSocketMessage(ws as never, JSON.stringify({ t: 'cmd', id: `c${n}`, cmd }));
    const ack = ws.messages().find((m) => m.t === 'ack' && m.id === `c${n}`);
    if (!ack?.ok) throw new Error(`cf ${cmd.type}: ${ack?.error}`);
  };
  for (const step of SCRIPT) {
    if (step === LATE_JOIN) {
      await dobj.webSocketMessage(sockets[3] as never, JSON.stringify({ t: 'join', seat: 4, nickname: '' }));
      const joined = sockets[3].last('joined');
      expect(joined).toMatchObject({ seat: 4, pending: true });
      await send(sockets[0], { type: 'host:approveJoin', seat: 4, chips: 1500 });
      await dobj.webSocketMessage(sockets[3] as never, JSON.stringify({ t: 'hello', protocolVersion: 1, token: joined.token }));
      expect(sockets[3].last('welcome').seat).toBe(4);
      continue;
    }
    const [seat, cmd] = step;
    if (n === 7) {
      // Simulate hibernation/eviction: a fresh object instance over the same storage + sockets.
      dobj = new RoomDurableObject(ctx as never, {} as never);
    }
    await send(sockets[seat - 1], cmd);
  }
  const state = (await ctx.storage.get<RoomState>('room'))!;
  // Every socket received the same authoritative final state.
  const views = sockets.map((s) => s.last('state').room);
  expect(new Set(views.map((v) => v.version)).size).toBe(1);
  expect(state.seats[2].connections).toBe(1);
  return { game: state.game, ctx, dobj, sockets };
}

describe('backend consistency', () => {
  it('Local Mode, Node.js and Cloudflare produce identical results', async () => {
    const local = runLocal();
    const node = await runNode();
    const cf = await runCloudflare();
    // Hand 2 eliminated seat 2; the host revived it with 1000 and seat 4 joined late with 1500.
    // Hand 3: pot 3×120 + 20 (seat 3 folded) = 380, won by seat 2 after seat 1 mucked.
    expect(local!.chips).toEqual({ 1: 1890, 2: 1260, 3: 3970, 4: 1380 });
    expect(local!.eliminations).toEqual([]);
    expect(local!.handCount).toBe(3);
    expect(normalize(node)).toEqual(normalize(local));
    expect(normalize(cf.game)).toEqual(normalize(local));
  });

  it('Cloudflare: alarms drive auto-fold and expiry; disconnects tracked', async () => {
    const { ctx, dobj, sockets } = await runCloudflare();
    await dobj.webSocketMessage(sockets[0] as never, JSON.stringify({ t: 'cmd', id: 'nh', cmd: { type: 'host:nextHand' } }));
    sockets[2].close();
    await dobj.webSocketClose(sockets[2] as never, 1006, '');
    const st = (await ctx.storage.get<RoomState>('room'))!;
    expect(st.seats[3].connections).toBe(0);
    expect(ctx.storage.alarm).toBe(st.seats[3].offlineSince! + 30_000);
    // Alarm fires "late": state says offline ≥ 30 s
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    try {
      await dobj.alarm();
      const after = (await ctx.storage.get<RoomState>('room'))!;
      expect(after.seats[3].autoFold).toBe(true);
      Date.now = () => realNow() + 25 * 3600_000;
      await dobj.alarm();
      expect(ctx.storage.map.size).toBe(0);
      expect(sockets[0].last('deleted')).toEqual({ t: 'deleted', reason: 'expired' });
    } finally {
      Date.now = realNow;
    }
  });
});
