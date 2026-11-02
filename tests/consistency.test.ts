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

/**
 * Sparse waiting room: host on seat 1, guests on seats 3 and 5, dealer chosen
 * on seat 5. Every backend must renumber to 1, 2, 3 at the start (dealer → 3)
 * and then play the same hand: D=3, SB=1, BB=2, seat 3 first to act.
 */
const SPARSE_PLAYERS: Array<[number, string]> = [
  [1, 'Host'],
  [3, 'Mia'],
  [5, 'Noa'],
];
const SPARSE_START: Command = { type: 'host:start', dealerSeat: 5 };
const SPARSE_SCRIPT: Array<[number, Command]> = [
  [3, { type: 'act', action: { type: 'raise', amount: 60 } }],
  [1, { type: 'act', action: { type: 'fold' } }],
  [2, { type: 'act', action: { type: 'call' } }],
  [1, { type: 'host:advance' }],
  [2, { type: 'act', action: { type: 'check' } }],
  [3, { type: 'act', action: { type: 'check' } }],
  [1, { type: 'host:advance' }],
  [2, { type: 'act', action: { type: 'check' } }],
  [3, { type: 'act', action: { type: 'check' } }],
  [1, { type: 'host:advance' }],
  [2, { type: 'act', action: { type: 'check' } }],
  [3, { type: 'act', action: { type: 'check' } }],
  [1, { type: 'host:award', winners: [[3]] }],
];
const SPARSE_TABLE = [
  [1, 'Host'],
  [2, 'Mia'],
  [3, 'Noa'],
];

function runSparseLocal() {
  let s: RoomState = createLocalRoom({ players: SPARSE_PLAYERS.map(([seat, nickname]) => ({ seat, nickname })), now: 0 });
  for (const [seat, cmd] of [[1, SPARSE_START] as [number, Command], ...SPARSE_SCRIPT]) {
    const c = PER_SEAT.has(cmd.type) ? ({ ...cmd, seat } as Command) : cmd;
    const r = applyCommand(s, { seat: null, local: true }, c, 0);
    if (!r.ok) throw new Error(`local ${cmd.type}: ${r.error}`);
    s = r.state;
  }
  return { game: s.game, table: Object.values(s.seats).map((x) => [x.seat, x.nickname]) };
}

async function runSparseNode() {
  const base = `http://127.0.0.1:${server.port}`;
  const created = await createRoomRequest(base, { settings: { maxPlayers: 6 }, nickname: 'Host' });
  if (!created.ok) throw new Error(created.error);
  const id = created.room.roomId;
  const t1 = new MemoryTokens();
  t1.set(id, created.room.token);
  const c = [client(base, id, t1), client(base, id), client(base, id)];
  await waitFor(() => c.every((x) => x.session.getSnapshot().connection === 'online'));
  expect((await c[1].session.join(3, 'Mia')).ok).toBe(true);
  expect((await c[2].session.join(5, 'Noa')).ok).toBe(true);
  expect((await c[0].session.send(SPARSE_START)).ok).toBe(true);
  await waitFor(() => c[1].session.getSnapshot().mySeat === 2 && c[2].session.getSnapshot().mySeat === 3, 5000, 'renumbered');
  // Clients are indexed by their in-game seat from here on.
  for (const [seat, cmd] of SPARSE_SCRIPT) {
    const r = await c[seat - 1].session.send(cmd);
    if (!r.ok) throw new Error(`node ${cmd.type}: ${r.error}`);
  }
  await waitFor(() => c.every((x) => x.session.getSnapshot().room?.game?.hand?.phase === 'complete'), 5000, 'hand complete');
  const views = c.map((x) => x.session.getSnapshot().room!);
  for (const v of views) expect(v.seats.map((x) => [x.seat, x.nickname])).toEqual(SPARSE_TABLE);
  const game = views[0].game;
  for (const x of c) x.session.dispose();
  return { game, table: views[0].seats.map((x) => [x.seat, x.nickname]) };
}

async function runSparseCloudflare() {
  const ctx = new FakeCtx();
  let dobj = new RoomDurableObject(ctx as never, {} as never);
  const settings = { maxPlayers: 6, startingChips: 2000, sb: 10, bb: 20, progression: 'hybrid', levelMinutes: 15, defaultLanguage: 'en' };
  const res = await dobj.fetch(
    new Request('https://room/internal/create', { method: 'POST', body: JSON.stringify({ id: 'CFSPR', game: 'texas-holdem', settings, nickname: 'Host', token: 'hosttoken' }) }),
  );
  expect(res.status).toBe(201);
  const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
  for (const ws of sockets) dobj.accept(ws as never);
  await dobj.webSocketMessage(sockets[0] as never, JSON.stringify({ t: 'hello', protocolVersion: 1, token: 'hosttoken' }));
  await dobj.webSocketMessage(sockets[1] as never, JSON.stringify({ t: 'join', seat: 3, nickname: 'Mia' }));
  await dobj.webSocketMessage(sockets[2] as never, JSON.stringify({ t: 'join', seat: 5, nickname: 'Noa' }));
  const miaToken = sockets[1].last('joined').token as string;
  let n = 0;
  const send = async (ws: FakeSocket, cmd: Command) => {
    n++;
    await dobj.webSocketMessage(ws as never, JSON.stringify({ t: 'cmd', id: `s${n}`, cmd }));
    const ack = ws.messages().find((m) => m.t === 'ack' && m.id === `s${n}`);
    if (!ack?.ok) throw new Error(`cf ${cmd.type}: ${ack?.error}`);
  };
  await send(sockets[0], SPARSE_START);
  // The seat binding lives in the socket attachment, so it survives hibernation.
  expect(sockets.map((ws) => ws.deserializeAttachment())).toEqual([{ seat: 1 }, { seat: 2 }, { seat: 3 }]);
  expect(sockets.map((ws) => ws.last('state').room.viewerSeat)).toEqual([1, 2, 3]);
  dobj = new RoomDurableObject(ctx as never, {} as never); // evicted and woken again
  for (const [seat, cmd] of SPARSE_SCRIPT) await send(sockets[seat - 1], cmd);
  // Mia reconnects on a new socket with her token and lands on her new seat.
  const fresh = new FakeSocket();
  dobj.accept(fresh as never);
  await dobj.webSocketMessage(fresh as never, JSON.stringify({ t: 'hello', protocolVersion: 1, token: miaToken }));
  expect(fresh.last('welcome').seat).toBe(2);
  const state = (await ctx.storage.get<RoomState>('room'))!;
  const views = sockets.map((ws) => ws.last('state').room);
  expect(new Set(views.map((v) => v.version)).size).toBe(1);
  for (const v of views) expect(v.seats.map((x: { seat: number; nickname: string }) => [x.seat, x.nickname])).toEqual(SPARSE_TABLE);
  return { game: state.game, table: Object.values(state.seats).map((x) => [x.seat, x.nickname]) };
}

describe('seat renumbering consistency', () => {
  it('Local Mode, Node.js and Cloudflare renumber sparse seats identically and play the same hand', async () => {
    const local = runSparseLocal();
    const node = await runSparseNode();
    const cf = await runSparseCloudflare();
    expect(local.table).toEqual(SPARSE_TABLE);
    expect(local.game!.firstDealer).toBe(3);
    // Pot 60 + 60 + 10 (folded small blind) won by seat 3.
    expect(local.game!.chips).toEqual({ 1: 1990, 2: 1940, 3: 2070 });
    expect(node.table).toEqual(SPARSE_TABLE);
    expect(cf.table).toEqual(SPARSE_TABLE);
    expect(normalize(node.game)).toEqual(normalize(local.game));
    expect(normalize(cf.game)).toEqual(normalize(local.game));
  });
});
