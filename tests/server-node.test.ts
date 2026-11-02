import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createRoomRequest, detectBackend, fetchRoomSummary } from '@feltcircle/game-session';
import { AUTO_FOLD_AFTER_MS, ROOM_TTL_MS } from '@feltcircle/game-protocol';
import { loadConfig } from '../apps/server-node/src/config.js';
import { startServer, type RunningServer } from '../apps/server-node/src/server.js';
import { backupDatabase } from '../apps/server-node/src/db.js';
import { client, MemoryTokens, waitFor } from './support.js';

const servers: RunningServer[] = [];
const sessions: { dispose(): void }[] = [];
let clock = Date.now();
const now = () => clock;

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-'));
  return path.join(dir, 'db.sqlite');
}

async function boot(dbFile = tmpDb(), env: Record<string, string> = {}) {
  const config = loadConfig({ PORT: '0', DB_FILE: dbFile, ...env });
  const s = await startServer(config, { now, log: () => {} });
  servers.push(s);
  return { server: s, base: `http://127.0.0.1:${s.port}`, dbFile };
}

afterEach(async () => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  clock = Date.now();
});

function track<T extends { session: { dispose(): void } }>(c: T): T {
  sessions.push(c.session);
  return c;
}

async function roomWithPlayers(base: string, n: number) {
  const created = await createRoomRequest(base, { settings: { maxPlayers: 6 }, nickname: 'Host' });
  if (!created.ok) throw new Error(created.error);
  const id = created.room.roomId;
  const hostTokens = new MemoryTokens();
  hostTokens.set(id, created.room.token);
  const players = [track(client(base, id, hostTokens))];
  await waitFor(() => players[0].session.getSnapshot().mySeat === 1, 5000, 'host welcome');
  for (let seat = 2; seat <= n; seat++) {
    const c = track(client(base, id));
    await waitFor(() => c.session.getSnapshot().connection === 'online');
    const r = await c.session.join(seat, `P${seat}`);
    expect(r.ok).toBe(true);
    players.push(c);
  }
  await waitFor(() => players.every((p) => p.session.getSnapshot().room?.seats.filter((s) => s.connected).length === n), 5000, 'all connected');
  return { id, players, s: (seat: number) => players[seat - 1].session };
}

describe('Node.js backend', () => {
  it('reports capabilities and passes detection', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/capabilities`);
    expect(await res.json()).toMatchObject({ app: 'feltcircle', protocolVersion: 1, features: { multiplayer: true, websocket: true, persistence: true } });
    const status = await detectBackend(base);
    expect(status.state).toBe('available');
    expect((await detectBackend('http://127.0.0.1:1')).state).toBe('unavailable');
  });

  it('creates rooms with valid ids and rejects bad settings', async () => {
    const { base } = await boot();
    const r = await createRoomRequest(base, { settings: {}, nickname: '' });
    expect(r.ok && r.room.roomId).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$/);
    const bad = await fetch(`${base}/api/rooms`, { method: 'POST', body: JSON.stringify({ settings: { maxPlayers: 11 } }) });
    expect(bad.status).toBe(400);
    const summary = await fetchRoomSummary(base, (r as { room: { roomId: string } }).room.roomId);
    expect(summary.ok && summary.room.occupied).toHaveLength(1);
    expect((await fetchRoomSummary(base, 'ZZZZZ')).ok).toBe(false);
  });

  it('advertises its games and rejects unsupported game types', async () => {
    const { base } = await boot();
    expect((await (await fetch(`${base}/api/capabilities`)).json()).games).toEqual(['texas-holdem']);
    const mahjong = await createRoomRequest(base, { game: 'riichi-mahjong', settings: {}, nickname: '' });
    expect(mahjong).toEqual({ ok: false, error: 'UNSUPPORTED_GAME' });
    const holdem = await createRoomRequest(base, { game: 'texas-holdem', settings: {}, nickname: '' });
    expect(holdem.ok).toBe(true);
    const summary = await fetchRoomSummary(base, (holdem as { room: { roomId: string } }).room.roomId);
    expect(summary.ok && summary.room.gameType).toBe('texas-holdem');
  });

  it('late join over WebSocket: request, host approval with chips, then the player is seated', async () => {
    const { base } = await boot();
    const { id, s } = await roomWithPlayers(base, 2);
    expect((await s(1).send({ type: 'host:start' })).ok).toBe(true);
    const late = track(client(base, id));
    await waitFor(() => late.session.getSnapshot().connection === 'online');
    expect((await late.session.join(4, 'Late')).ok).toBe(true);
    expect(late.session.getSnapshot()).toMatchObject({ mySeat: null, pendingSeat: 4 });
    await waitFor(() => s(1).getSnapshot().room!.joinRequests.length === 1, 5000, 'host sees request');
    // The requester can reconnect and is still recognised as pending.
    late.session.dispose();
    const again = track(client(base, id, late.tokens));
    await waitFor(() => again.session.getSnapshot().pendingSeat === 4, 5000, 'pending after reconnect');
    expect((await s(1).send({ type: 'host:approveJoin', seat: 4, chips: 3500 })).ok).toBe(true);
    await waitFor(() => again.session.getSnapshot().mySeat === 4, 5000, 'seated after approval');
    expect(again.session.getSnapshot().pendingSeat).toBe(null);
    await waitFor(() => s(1).getSnapshot().room!.seats.find((x) => x.seat === 4)?.connected === true, 5000, 'connected');
    expect(again.session.getSnapshot().room!.game!.chips[4]).toBe(3500);
  });

  it('renumbers sparse seats at the start: every client agrees and reconnects to its new seat', async () => {
    const { base, server } = await boot();
    const created = await createRoomRequest(base, { settings: { maxPlayers: 6 }, nickname: 'Host' });
    if (!created.ok) throw new Error(created.error);
    const id = created.room.roomId;
    const hostTokens = new MemoryTokens();
    hostTokens.set(id, created.room.token);
    const host = track(client(base, id, hostTokens));
    const p3 = track(client(base, id));
    const p6 = track(client(base, id));
    await waitFor(() => [host, p3, p6].every((c) => c.session.getSnapshot().connection === 'online'));
    expect((await p3.session.join(3, 'P3')).ok).toBe(true);
    expect((await p6.session.join(6, 'P6')).ok).toBe(true);
    // Waiting room: original numbers.
    expect(p6.session.getSnapshot().mySeat).toBe(6);

    expect((await host.session.send({ type: 'host:start', dealerSeat: 6 })).ok).toBe(true);
    await waitFor(
      () => p3.session.getSnapshot().mySeat === 2 && p6.session.getSnapshot().mySeat === 3 && host.session.getSnapshot().mySeat === 1,
      5000,
      'renumbered seats',
    );
    const table = (c: typeof host) => c.session.getSnapshot().room!.seats.map((x) => [x.seat, x.nickname, x.connected]);
    await waitFor(() => [host, p3, p6].every((c) => c.session.getSnapshot().room?.status === 'playing'));
    for (const c of [host, p3, p6]) {
      expect(table(c)).toEqual([
        [1, 'Host', true],
        [2, 'P3', true],
        [3, 'P6', true],
      ]);
      expect(c.session.getSnapshot().room!.hostSeat).toBe(1);
    }
    expect(host.session.getSnapshot().isHost).toBe(true);
    // Dealer chosen in the waiting room (seat 6) is in-game seat 3; SB 1, BB 2, seat 3 acts first.
    const hand = p6.session.getSnapshot().room!.game!.hand!;
    expect([hand.dealer, hand.sbSeat, hand.bbSeat, hand.toAct]).toEqual([3, 1, 2, 3]);
    // The server bound each connection to the new seat: turn checks follow the player.
    expect((await p3.session.send({ type: 'act', action: { type: 'call' } })).error).toBe('NOT_YOUR_TURN');
    expect((await p6.session.send({ type: 'act', action: { type: 'call' } })).ok).toBe(true);
    await waitFor(() => host.session.getSnapshot().room!.game!.hand!.toAct === 1);

    // Reconnect with the stored token (e.g. reload): back on the mapped seat.
    p3.session.dispose();
    await waitFor(() => host.session.getSnapshot().room!.seats.find((x) => x.seat === 2)?.connected === false, 5000, 'offline');
    const again = track(client(base, id, p3.tokens));
    await waitFor(() => again.session.getSnapshot().mySeat === 2, 5000, 'reconnected to seat 2');
    await waitFor(() => host.session.getSnapshot().room!.seats.find((x) => x.seat === 2)?.connected === true, 5000, 'online again');

    // Persisted atomically with the start: the stored room has the renumbered table.
    const stored = server.db.get(id, now())!;
    expect(Object.values(stored.seats).map((x) => [x.seat, x.nickname])).toEqual([
      [1, 'Host'],
      [2, 'P3'],
      [3, 'P6'],
    ]);
    expect(stored.game!.seats).toEqual([1, 2, 3]);
  });

  it('a rejected late joiner is told so', async () => {
    const { base } = await boot();
    const { id, s } = await roomWithPlayers(base, 2);
    await s(1).send({ type: 'host:start' });
    const late = track(client(base, id));
    await waitFor(() => late.session.getSnapshot().connection === 'online');
    await late.session.join(3, '');
    await waitFor(() => s(1).getSnapshot().room!.joinRequests.length === 1);
    expect((await s(1).send({ type: 'host:rejectJoin', seat: 3 })).ok).toBe(true);
    await waitFor(() => late.session.getSnapshot().lastError?.code === 'JOIN_REJECTED', 5000, 'rejected');
    expect(late.session.getSnapshot()).toMatchObject({ mySeat: null, pendingSeat: null });
    expect(late.tokens.get(id)).toBe(null);
  });

  it('rate-limits room creation per IP', async () => {
    const { base } = await boot(undefined, { ROOM_CREATE_LIMIT: '2' });
    expect((await createRoomRequest(base, { settings: {}, nickname: '' })).ok).toBe(true);
    expect((await createRoomRequest(base, { settings: {}, nickname: '' })).ok).toBe(true);
    const third = await createRoomRequest(base, { settings: {}, nickname: '' });
    expect(third).toEqual({ ok: false, error: 'RATE_LIMITED' });
  });

  it('plays a full hand with server validation and broadcasts to everyone', async () => {
    const { base } = await boot();
    const { s } = await roomWithPlayers(base, 3);
    expect((await s(2).send({ type: 'host:start' })).error).toBe('NOT_HOST');
    expect((await s(1).send({ type: 'host:start' })).ok).toBe(true);
    await waitFor(() => s(3).getSnapshot().room?.status === 'playing');
    // D=1 SB=2 BB=3 → seat 1 first preflop
    expect((await s(2).send({ type: 'act', action: { type: 'call' } })).error).toBe('NOT_YOUR_TURN');
    expect((await s(1).send({ type: 'act', action: { type: 'raise', amount: 100 } })).ok).toBe(true);
    expect((await s(2).send({ type: 'act', action: { type: 'fold' } })).ok).toBe(true);
    expect((await s(3).send({ type: 'act', action: { type: 'fold' } })).ok).toBe(true);
    await waitFor(() => s(2).getSnapshot().room?.game?.hand?.phase === 'complete');
    expect(s(2).getSnapshot().room!.game!.chips).toEqual({ 1: 2030, 2: 1990, 3: 1980 });
  });

  it('rejects malformed messages and bad seats', async () => {
    const { base } = await boot();
    const created = await createRoomRequest(base, { settings: {}, nickname: '' });
    if (!created.ok) throw new Error();
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${created.room.roomId}`);
    const msgs: string[] = [];
    ws.on('message', (d) => msgs.push(d.toString()));
    await new Promise((r) => ws.on('open', r));
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'cmd', id: 'x', cmd: { type: 'act', action: { type: 'bet', amount: -5 } } }));
    ws.send(JSON.stringify({ t: 'hello', protocolVersion: 1 }));
    ws.send(JSON.stringify({ t: 'join', seat: 1, nickname: 'thief' }));
    await waitFor(() => msgs.length >= 4);
    expect(msgs.slice(0, 2).map((m) => JSON.parse(m).error)).toEqual(['INVALID_MESSAGE', 'INVALID_MESSAGE']);
    expect(JSON.parse(msgs[2]).t).toBe('welcome');
    expect(JSON.parse(msgs[3]).error).toBe('SEAT_TAKEN');
    ws.close();
    const nf = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/ZZZZZ/ws`);
    const err = await new Promise<string>((r) => nf.on('message', (d) => r(d.toString())));
    expect(JSON.parse(err).error).toBe('ROOM_NOT_FOUND');
  });

  it('reconnects and resynchronizes the full state', async () => {
    const { base } = await boot();
    const { id, s, players } = await roomWithPlayers(base, 2);
    await s(1).send({ type: 'host:start' });
    const tokens2 = players[1].tokens;
    s(2).dispose();
    await waitFor(() => s(1).getSnapshot().room!.seats.find((x) => x.seat === 2)!.connected === false);
    await s(1).send({ type: 'act', action: { type: 'call' } });
    const again = track(client(base, id, tokens2));
    await waitFor(() => again.session.getSnapshot().mySeat === 2 && again.session.getSnapshot().room?.game?.hand?.toAct === 2);
    expect(again.session.getSnapshot().room!.version).toBe(s(1).getSnapshot().room!.version);
    expect((await again.session.send({ type: 'act', action: { type: 'check' } })).ok).toBe(true);
  });

  it('host claim when host disconnects; previous host returns without authority', async () => {
    const { base } = await boot();
    const { id, s, players } = await roomWithPlayers(base, 3);
    const hostTokens = players[0].tokens;
    s(1).dispose();
    await waitFor(() => s(2).getSnapshot().room!.seats[0].connected === false);
    const [a, b] = await Promise.all([s(2).send({ type: 'claimHost' }), s(3).send({ type: 'claimHost' })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const back = track(client(base, id, hostTokens));
    await waitFor(() => back.session.getSnapshot().mySeat === 1);
    expect(back.session.getSnapshot().isHost).toBe(false);
    expect(back.session.getSnapshot().room!.hostSeat).toBe(a.ok ? 2 : 3);
  });

  it('auto-folds a player disconnected for 30 s using server-side timers', async () => {
    const { base, server } = await boot();
    const { id, s } = await roomWithPlayers(base, 3);
    await s(1).send({ type: 'host:start' });
    s(2).dispose();
    await waitFor(() => s(1).getSnapshot().room!.seats[1].connected === false);
    clock += AUTO_FOLD_AFTER_MS;
    const room = await server.rooms.get(id)!;
    await room!.runtime.onWake();
    await waitFor(() => s(1).getSnapshot().room!.seats[1].autoFold);
    await s(1).send({ type: 'act', action: { type: 'raise', amount: 60 } });
    await waitFor(() => s(3).getSnapshot().room!.game!.hand!.toAct === 3);
    expect(s(3).getSnapshot().room!.game!.hand!.seats.find((x) => x.seat === 2)!.folded).toBe(true);
  });

  it('restores rooms after a server restart (SQLite persistence)', async () => {
    const first = await boot();
    const { id, s, players } = await roomWithPlayers(first.base, 2);
    await s(1).send({ type: 'host:start' });
    await s(1).send({ type: 'act', action: { type: 'call' } });
    const version = s(1).getSnapshot().room!.version;
    const tokens = players.map((p) => p.tokens);
    for (const p of players) p.session.dispose();
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);

    const second = await boot(first.dbFile);
    const c2 = track(client(second.base, id, tokens[1]));
    await waitFor(() => c2.session.getSnapshot().mySeat === 2 && !!c2.session.getSnapshot().room);
    const room = c2.session.getSnapshot().room!;
    expect(room.version).toBeGreaterThanOrEqual(version);
    expect(room.game!.hand!.toAct).toBe(2);
    expect(room.seats.find((x) => x.seat === 1)!.connected).toBe(false);
    expect((await c2.session.send({ type: 'act', action: { type: 'check' } })).ok).toBe(true);
  });

  it('takes an online backup that a fresh server can restore from', async () => {
    const live = await boot();
    const created = await createRoomRequest(live.base, { settings: {}, nickname: 'Host' });
    if (!created.ok) throw new Error(created.error);
    const target = path.join(path.dirname(live.dbFile), 'backup', 'copy.sqlite');
    backupDatabase(live.dbFile, target); // while the server is running
    expect(() => backupDatabase(live.dbFile, target)).toThrow(/overwrite/);
    const restored = await boot(target);
    const summary = await fetchRoomSummary(restored.base, created.room.roomId);
    expect(summary.ok).toBe(true);
  });

  it('expires rooms 24 h after the last activity and lets the host delete early', async () => {
    const { base, server } = await boot();
    const a = await createRoomRequest(base, { settings: {}, nickname: '' });
    const b = await createRoomRequest(base, { settings: {}, nickname: '' });
    if (!a.ok || !b.ok) throw new Error();
    clock += ROOM_TTL_MS + 1;
    expect(server.db.deleteExpired(clock)).toBe(2);
    expect((await fetchRoomSummary(base, a.room.roomId)).ok).toBe(false);

    const c = await createRoomRequest(base, { settings: {}, nickname: '' });
    if (!c.ok) throw new Error();
    const tokens = new MemoryTokens();
    tokens.set(c.room.roomId, c.room.token);
    const host = track(client(base, c.room.roomId, tokens));
    await waitFor(() => host.session.getSnapshot().mySeat === 1);
    await host.session.send({ type: 'host:deleteRoom' });
    await waitFor(() => host.session.getSnapshot().gone === 'host');
    expect((await fetchRoomSummary(base, c.room.roomId)).ok).toBe(false);
  });
});
