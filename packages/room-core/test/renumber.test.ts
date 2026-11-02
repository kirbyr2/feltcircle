import { describe, expect, it } from 'vitest';
import type { Command } from '@feltcircle/game-protocol';
import {
  applyCommand,
  connectSeat,
  createLocalRoom,
  createOnlineRoom,
  joinSeat,
  requestSeat,
  seatForToken,
  seatRenumbering,
  toView,
  type RoomState,
} from '../src/index.js';

const now = 7_000_000;
let ids = 0;
function cmd(state: RoomState, seat: number | null, c: Command, commandId = `r${++ids}`) {
  return applyCommand(state, { seat }, c, now, commandId);
}
function ok(state: RoomState, seat: number | null, c: Command) {
  const r = cmd(state, seat, c);
  if (!r.ok) throw new Error(`${c.type} failed: ${r.error}`);
  return r.state;
}

/** Online waiting room: host on seat 1 (token t1), guests on `others` (tokens t<seat>, names P<seat>). */
function sparseRoom(others: number[], maxPlayers = 8): RoomState {
  let s = createOnlineRoom({ id: 'SPRSE', hostToken: 't1', hostNickname: 'Host', now, settings: { maxPlayers } });
  s = connectSeat(s, 1, now);
  for (const seat of others) {
    s = joinSeat(s, seat, `P${seat}`, `t${seat}`, now);
    s = connectSeat(s, seat, now);
  }
  return s;
}

const occupied = (s: RoomState) => Object.keys(s.seats).map(Number).sort((a, b) => a - b);
const names = (s: RoomState) => Object.fromEntries(Object.values(s.seats).map((r) => [r.seat, r.nickname]));

describe('seatRenumbering', () => {
  it('closes gaps in clockwise order', () => {
    expect(seatRenumbering([1, 2, 4, 6])).toEqual({ 1: 1, 2: 2, 4: 3, 6: 4 });
    expect(seatRenumbering([6, 2, 4, 1])).toEqual({ 1: 1, 2: 2, 4: 3, 6: 4 });
    expect(seatRenumbering([3, 5, 8])).toEqual({ 3: 1, 5: 2, 8: 3 });
    expect(seatRenumbering([1, 2, 3])).toEqual({ 1: 1, 2: 2, 3: 3 });
  });
});

describe('renumbering when the game starts', () => {
  it('maps waiting-room seats 1, 2, 4, 6 to 1, 2, 3, 4 atomically, keeping identities and the chosen dealer', () => {
    const lobby = sparseRoom([2, 4, 6]);
    // Seats keep their waiting-room numbers until the start.
    expect(occupied(lobby)).toEqual([1, 2, 4, 6]);
    expect(toView(lobby, 4, now).viewerSeat).toBe(4);

    const r = cmd(lobby, 1, { type: 'host:start', dealerSeat: 4 });
    expect(r.ok).toBe(true);
    expect(r.seatMap).toEqual({ 1: 1, 2: 2, 4: 3, 6: 4 });
    const s = r.state;
    expect(occupied(s)).toEqual([1, 2, 3, 4]);
    expect(names(s)).toEqual({ 1: 'Host', 2: 'P2', 3: 'P4', 4: 'P6' });
    expect(Object.values(s.seats).every((x) => x.connections === 1)).toBe(true);
    // Reconnect credentials follow the players.
    expect(seatForToken(s, 't1')).toBe(1);
    expect(seatForToken(s, 't4')).toBe(3);
    expect(seatForToken(s, 't6')).toBe(4);
    expect(s.hostSeat).toBe(1);
    // Game state uses the new numbers only.
    const g = s.game!;
    expect(g.seats).toEqual([1, 2, 3, 4]);
    expect(Object.keys(g.chips).map(Number)).toEqual([1, 2, 3, 4]);
    // The host picked P4 (waiting seat 4) as dealer: in-game seat 3. SB/BB/first to act follow clockwise.
    const h = g.hand!;
    expect(h.dealer).toBe(3);
    expect([h.sbSeat, h.bbSeat, h.toAct]).toEqual([4, 1, 2]);
    expect(h.seats.map((x) => x.seat)).toEqual([1, 2, 3, 4]);
    // Every view agrees, and each viewer learns its new seat.
    expect(toView(s, 3, now).viewerSeat).toBe(3);
    expect(toView(s, 4, now).seats.map((x) => [x.seat, x.nickname])).toEqual([
      [1, 'Host'],
      [2, 'P2'],
      [3, 'P4'],
      [4, 'P6'],
    ]);
    expect(s.log.map((e) => e.code).slice(-2)).toEqual(['seatsRenumbered', 'started']);
    // Lobby history follows the players to their new numbers.
    expect(s.log.filter((e) => e.code === 'joined').map((e) => e.seat)).toEqual([2, 3, 4]);
  });

  it('turn order uses the new seats: actions are validated against the renumbered seats', () => {
    let s = ok(sparseRoom([2, 4, 6]), 1, { type: 'host:start', dealerSeat: 4 });
    // In-game seat 2 acts first; the player formerly on seat 4 (now 3) has to wait.
    expect(cmd(s, 3, { type: 'act', action: { type: 'call' } }).error).toBe('NOT_YOUR_TURN');
    s = ok(s, 2, { type: 'act', action: { type: 'call' } });
    s = ok(s, 3, { type: 'act', action: { type: 'call' } });
    s = ok(s, 4, { type: 'act', action: { type: 'call' } });
    s = ok(s, 1, { type: 'act', action: { type: 'check' } });
    expect(s.game!.hand!.phase).toBe('street-complete');
    expect(s.game!.hand!.log.map((e) => e.seat)).toEqual([4, 1, 2, 3, 4, 1]);
  });

  it('handles an empty seat 1: the lowest occupied seat becomes 1 and the host keeps the role', () => {
    let s = sparseRoom([3, 5, 8]);
    s = ok(s, 1, { type: 'host:transfer', seat: 5 });
    s = ok(s, 1, { type: 'leaveSeat' });
    expect(occupied(s)).toEqual([3, 5, 8]);
    expect(s.hostSeat).toBe(5);

    const r = cmd(s, 5, { type: 'host:start', dealerSeat: 8 });
    expect(r.ok).toBe(true);
    expect(r.seatMap).toEqual({ 3: 1, 5: 2, 8: 3 });
    s = r.state;
    expect(occupied(s)).toEqual([1, 2, 3]);
    expect(names(s)).toEqual({ 1: 'P3', 2: 'P5', 3: 'P8' });
    expect(s.hostSeat).toBe(2);
    expect(seatForToken(s, 't5')).toBe(2);
    expect(seatForToken(s, 't1')).toBe(null);
    const h = s.game!.hand!;
    expect([h.dealer, h.sbSeat, h.bbSeat, h.toAct]).toEqual([3, 1, 2, 3]);
    // The host still runs the table from the new seat.
    expect(cmd(s, 1, { type: 'host:pause' }).error).toBe('NOT_HOST');
    expect(cmd(s, 2, { type: 'host:pause' }).ok).toBe(true);
    // History never points at a seat number that now belongs to someone else.
    const seatsInLog = s.log.flatMap((e) => [e.seat, ...(e.code === 'hostTransferred' ? [e.params!.from, e.params!.to] : [])]);
    expect(seatsInLog.every((x) => x === null || [1, 2, 3].includes(x as number))).toBe(true);
    expect(s.log.some((e) => e.code === 'left')).toBe(false);
  });

  it('defaults the dealer to the lowest occupied seat (in-game seat 1)', () => {
    const s = ok(sparseRoom([4, 7]), 1, { type: 'host:start' });
    expect(occupied(s)).toEqual([1, 2, 3]);
    expect(s.game!.hand!.dealer).toBe(1);
  });

  it('does not renumber consecutive seats, and never again between hands', () => {
    const consecutive = cmd(sparseRoom([2, 3]), 1, { type: 'host:start' });
    expect(consecutive.seatMap).toBeUndefined();
    expect(consecutive.state.log.some((e) => e.code === 'seatsRenumbered')).toBe(false);

    let s = ok(sparseRoom([3, 6], 6), 1, { type: 'host:start' });
    expect(occupied(s)).toEqual([1, 2, 3]);
    // A late joiner takes a free seat after the start; it is not renumbered later.
    s = requestSeat(s, 5, 'Late', 'tL', now);
    s = ok(s, 1, { type: 'host:approveJoin', seat: 5, chips: 1500 });
    expect(seatForToken(s, 'tL')).toBe(5);
    // Finish hand 1 (D=1, SB=2, BB=3 → seat 1 acts first) by folding to the big blind.
    s = ok(s, 1, { type: 'act', action: { type: 'fold' } });
    s = ok(s, 2, { type: 'act', action: { type: 'fold' } });
    expect(s.game!.hand!.phase).toBe('complete');
    const next = cmd(s, 1, { type: 'host:nextHand' });
    expect(next.ok).toBe(true);
    expect(next.seatMap).toBeUndefined();
    expect(occupied(next.state)).toEqual([1, 2, 3, 5]);
    expect(next.state.game!.hand!.seats.map((x) => x.seat)).toEqual([1, 2, 3, 5]);
    // Moving big blind: 3 → 5; SB 3; the button stays clockwise before it.
    const h = next.state.game!.hand!;
    expect([h.dealer, h.sbSeat, h.bbSeat]).toEqual([2, 3, 5]);
  });

  it('applies staged chip imports to the right players', () => {
    let s = sparseRoom([2, 5]);
    s = ok(s, 1, { type: 'host:import', seats: { 1: 1200, 2: 3000, 5: 800 }, resolution: null });
    s = ok(s, 1, { type: 'host:start' });
    expect(s.game!.chips).toEqual({ 1: 1200, 2: 3000, 3: 800 });
    expect(s.seats[3].nickname).toBe('P5');
  });

  it('keeps idempotency across the renumbering: a retried start is recognised', () => {
    let s = sparseRoom([2, 4]);
    s = ok(s, 1, { type: 'host:transfer', seat: 4 });
    const first = cmd(s, 4, { type: 'host:start' }, 'start-1');
    expect(first.ok).toBe(true);
    // The host was on seat 4 and is on seat 3 now; the resent command arrives from seat 3.
    expect(first.state.hostSeat).toBe(3);
    const retry = cmd(first.state, 3, { type: 'host:start' }, 'start-1');
    expect(retry).toMatchObject({ ok: true, duplicate: true });
  });

  it('Local Mode closes gaps the same way (e.g. after importing chips from a sparse table)', () => {
    const local = createLocalRoom({ players: [{ seat: 2, nickname: 'Ana' }, { seat: 4, nickname: 'Ben' }, { seat: 7, nickname: 'Cy' }], chips: { 2: 500, 4: 900, 7: 1100 }, now });
    const r = applyCommand(local, { seat: null, local: true }, { type: 'host:start', dealerSeat: 4 }, now);
    expect(r.ok).toBe(true);
    expect(names(r.state)).toEqual({ 1: 'Ana', 2: 'Ben', 3: 'Cy' });
    expect(r.state.game!.chips).toEqual({ 1: 500, 2: 900, 3: 1100 });
    expect(r.state.game!.hand!.dealer).toBe(2);
  });
});
