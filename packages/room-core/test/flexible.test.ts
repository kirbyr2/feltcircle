import { describe, expect, it } from 'vitest';
import { parseCreateRoomBody, type Command } from '@feltcircle/game-protocol';
import {
  applyCommand,
  connectSeat,
  createLocalRoom,
  createOnlineRoom,
  disconnectSeat,
  joinSeat,
  normalizeRoom,
  requestForToken,
  requestSeat,
  toSummary,
  toView,
  type RoomState,
} from '../src/index.js';

const now = 5_000_000;
let ids = 0;
function cmd(state: RoomState, seat: number | null, c: Command, local = false) {
  return applyCommand(state, { seat, local }, c, now, `f${++ids}`);
}
function ok(state: RoomState, seat: number | null, c: Command, local = false) {
  const r = cmd(state, seat, c, local);
  if (!r.ok) throw new Error(`${c.type} failed: ${r.error}`);
  return r.state;
}
function onlineRoom(n: number, settings = {}): RoomState {
  let s = createOnlineRoom({ id: 'ABCDE', hostToken: 't1', now, settings });
  s = connectSeat(s, 1, now);
  for (let i = 2; i <= n; i++) {
    s = joinSeat(s, i, `P${i}`, `t${i}`, now);
    s = connectSeat(s, i, now);
  }
  return s;
}
const act = (type: 'fold' | 'check' | 'call' | 'allin'): Command => ({ type: 'act', action: { type } });

/** Play the current hand to showdown by calling/checking. */
function toShowdown(s: RoomState): RoomState {
  for (let i = 0; i < 50 && s.game!.hand!.phase !== 'showdown'; i++) {
    const h = s.game!.hand!;
    if (h.phase === 'street-complete') s = ok(s, s.hostSeat, { type: 'host:advance' });
    else {
      const me = h.seats.find((x) => x.seat === h.toAct)!;
      s = ok(s, h.toAct, act(me.bet < h.currentBet ? 'call' : 'check'));
    }
  }
  return s;
}

describe('game catalog', () => {
  it('creates Texas Hold\'em rooms and rejects unsupported games', () => {
    expect(parseCreateRoomBody({ settings: {} })).toMatchObject({ ok: true, body: { game: 'texas-holdem' } });
    expect(parseCreateRoomBody({ game: 'texas-holdem', settings: {} }).ok).toBe(true);
    expect(parseCreateRoomBody({ game: 'riichi-mahjong', settings: {} })).toEqual({ ok: false, error: 'UNSUPPORTED_GAME' });
    expect(parseCreateRoomBody({ game: 'chess', settings: {} })).toEqual({ ok: false, error: 'UNSUPPORTED_GAME' });
    expect(parseCreateRoomBody({ settings: { sb: 20, bb: 20 } })).toEqual({ ok: false, error: 'INVALID_SETTINGS' });
    expect(toView(onlineRoom(1), 1, now).gameType).toBe('texas-holdem');
  });

  it('upgrades rooms stored before late joins and claims existed', () => {
    const legacy = onlineRoom(2) as Partial<RoomState>;
    delete legacy.requests;
    delete legacy.claims;
    delete legacy.gameType;
    const s = normalizeRoom(legacy as RoomState);
    expect(s.requests).toEqual({});
    expect(s.claims).toEqual([]);
    expect(s.gameType).toBe('texas-holdem');
  });
});

describe('late joining', () => {
  it('request → host approves with custom chips → dealt in from the next hand', () => {
    let s = ok(onlineRoom(3, { maxPlayers: 6 }), 1, { type: 'host:start' });
    expect(() => joinSeat(s, 5, 'Late', 'tl', now)).toThrow('GAME_STARTED');
    s = requestSeat(s, 5, 'Late', 'tl', now);
    expect(requestForToken(s, 'tl')).toBe(5);
    expect(toView(s, 1, now).joinRequests).toEqual([{ seat: 5, nickname: 'Late', at: now }]);
    expect(toSummary(s).requested).toEqual([5]);
    expect(() => requestSeat(s, 5, 'Other', 'tx', now)).toThrow('SEAT_TAKEN');
    expect(cmd(s, 2, { type: 'host:approveJoin', seat: 5, chips: 3000 }).error).toBe('NOT_HOST');

    const handBefore = structuredClone(s.game!.hand);
    s = ok(s, 1, { type: 'host:approveJoin', seat: 5, chips: 3000 });
    expect(s.seats[5]).toMatchObject({ nickname: 'Late', token: 'tl' });
    expect(s.game!.chips[5]).toBe(3000);
    expect(s.game!.hand).toEqual(handBefore); // the running hand is untouched
    expect(s.requests).toEqual({});

    // Finish the hand, then the new player is dealt in.
    s = ok(s, s.game!.hand!.toAct, act('fold'));
    s = ok(s, s.game!.hand!.toAct, act('fold'));
    s = ok(s, 1, { type: 'host:nextHand' });
    expect(s.game!.hand!.seats.map((x) => x.seat)).toEqual([1, 2, 3, 5]);
  });

  it('host can reject a request, and can enlarge the table during a game', () => {
    let s = ok(onlineRoom(2, { maxPlayers: 2 }), 1, { type: 'host:start' });
    expect(() => requestSeat(s, 3, '', 'tx', now)).toThrow('INVALID_SEAT');
    s = ok(s, 1, { type: 'host:setSettings', settings: { maxPlayers: 4 } });
    expect(cmd(s, 1, { type: 'host:setSettings', settings: { startingChips: 5 } }).error).toBe('GAME_STARTED');
    s = requestSeat(s, 3, 'Nope', 'tx', now);
    s = ok(s, 1, { type: 'host:rejectJoin', seat: 3 });
    expect(s.requests).toEqual({});
    expect(s.seats[3]).toBeUndefined();
  });

  it('a reconnecting player keeps their balance instead of getting new chips', () => {
    let s = ok(onlineRoom(2), 1, { type: 'host:start' });
    s = ok(s, s.game!.hand!.toAct, act('fold'));
    const chips = { ...s.game!.chips };
    s = disconnectSeat(s, 2, now);
    s = joinSeat(s, 2, '', 'phone2', now, true); // takeover after switching phones
    expect(s.game!.chips).toEqual(chips);
  });

  it('approving a join can revive a finished game', () => {
    let s = ok(onlineRoom(2, { startingChips: 100 }), 1, { type: 'host:start' });
    s = ok(s, s.game!.hand!.toAct, act('allin'));
    s = ok(s, s.game!.hand!.toAct, act('call'));
    s = toShowdown(s);
    s = ok(s, 1, { type: 'host:award', winners: [[1]] });
    expect(s.status).toBe('finished');
    s = requestSeat(s, 3, 'New', 'tn', now);
    s = ok(s, 1, { type: 'host:approveJoin', seat: 3, chips: 500 });
    expect(s.status).toBe('playing');
    s = ok(s, 1, { type: 'host:nextHand' });
    expect(s.game!.hand!.seats.map((x) => x.seat)).toEqual([1, 3]);
  });

  it('Local Mode adds players directly', () => {
    let s = createLocalRoom({ players: [{ seat: 1 }, { seat: 2 }], now });
    s = ok(s, null, { type: 'host:start' }, true);
    s = ok(s, null, { type: 'host:addPlayer', seat: 7, nickname: 'Gina', chips: 1000 }, true);
    expect(s.settings.maxPlayers).toBe(7);
    expect(s.game!.chips[7]).toBe(1000);
    expect(cmd(s, null, { type: 'host:addPlayer', seat: 7, nickname: '', chips: 1 }, true).error).toBe('SEAT_TAKEN');
  });
});

describe('administrative chip adjustments', () => {
  it('between hands only, recorded in the history, any total allowed', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    expect(cmd(s, 1, { type: 'host:setChips', seat: 2, chips: 9999 }).error).toBe('HAND_IN_PROGRESS');
    s = ok(s, s.game!.hand!.toAct, act('fold'));
    s = ok(s, s.game!.hand!.toAct, act('fold'));
    expect(cmd(s, 2, { type: 'host:setChips', seat: 2, chips: 9999 }).error).toBe('NOT_HOST');
    const from = s.game!.chips[2];
    s = ok(s, 1, { type: 'host:setChips', seat: 2, chips: 9999 });
    expect(s.game!.chips[2]).toBe(9999);
    expect(s.log.at(-1)).toMatchObject({ code: 'chipsAdjusted', params: { seat: 2, from, to: 9999 } });
    s = ok(s, 1, { type: 'host:undo' });
    expect(s.game!.chips[2]).toBe(from);
  });
});

describe('showdown victory claims', () => {
  /** Seats 1 (short, 100) all-in vs 2 and 3 (1000 each) → main pot 1/2/3, side pot 2/3. */
  function sidePotShowdown(): RoomState {
    let s = onlineRoom(3);
    s = ok(s, 1, { type: 'host:start', dealerSeat: 3 });
    // Finish hand 1 quickly, then give the players uneven stacks between hands.
    s = ok(s, s.game!.hand!.toAct, act('fold'));
    s = ok(s, s.game!.hand!.toAct, act('fold'));
    s = ok(s, 1, { type: 'host:import', seats: { 1: 100, 2: 1000, 3: 1000 }, resolution: null });
    s = ok(s, 1, { type: 'host:nextHand' });
    // Dealer 1, SB 2, BB 3. Preflop: 1 all-in for 100, 2 and 3 call.
    expect(s.game!.hand!).toMatchObject({ dealer: 1, sbSeat: 2, bbSeat: 3, toAct: 1 });
    s = ok(s, 1, act('allin'));
    s = ok(s, 2, act('call'));
    s = ok(s, 3, act('call'));
    s = ok(s, 1, { type: 'host:advance' });
    // Flop: 2 bets 200, 3 calls → side pot between 2 and 3.
    s = ok(s, 2, { type: 'act', action: { type: 'bet', amount: 200 } });
    s = ok(s, 3, act('call'));
    return toShowdown(s);
  }

  it('eligible players claim and withdraw; claims never move chips; host settles per pot', () => {
    let s = sidePotShowdown();
    const pots = toView(s, 1, now).pots;
    expect(pots.length).toBe(2);
    expect(pots[1].eligible).not.toContain(1);

    const chipsBefore = { ...s.game!.chips };
    const handBefore = structuredClone(s.game!.hand);
    s = ok(s, 2, { type: 'claim', won: true });
    s = ok(s, 3, { type: 'claim', won: true });
    expect(toView(s, 3, now).claims).toEqual([2, 3]);
    expect(s.game!.chips).toEqual(chipsBefore);
    expect(s.game!.hand).toEqual(handBefore);
    s = ok(s, 3, { type: 'claim', won: false });
    expect(s.claims).toEqual([2]);
    expect(cmd(s, 2, { type: 'claim', won: true, seat: 3 }).error).toBe('NOT_ALLOWED'); // only your own seat online

    s = ok(s, 1, { type: 'host:award', winners: [[2], [2]] });
    expect(s.claims).toEqual([]);
    expect(s.game!.hand!.phase).toBe('complete');
  });

  it('claims are only possible at showdown for players still in the pot', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    expect(cmd(s, 2, { type: 'claim', won: true }).error).toBe('WRONG_PHASE');
    s = ok(s, s.game!.hand!.toAct, act('fold'));
    const folded = s.game!.hand!.seats.find((x) => x.folded)!.seat;
    s = toShowdown(s);
    expect(cmd(s, folded, { type: 'claim', won: true }).error).toBe('NOT_ELIGIBLE');
  });

  it('"I lost / muck" removes a player from every pot and settles when one contender is left', () => {
    let s = ok(onlineRoom(2), 1, { type: 'host:start' });
    s = toShowdown(s);
    s = ok(s, 2, { type: 'claim', won: true });
    s = ok(s, 1, { type: 'muck' });
    expect(s.game!.hand!.phase).toBe('complete');
    expect(s.game!.chips).toEqual({ 1: 1980, 2: 2020 });
    expect(s.claims).toEqual([]);
    expect(s.log.some((e) => e.code === 'mucked' && e.seat === 1)).toBe(true);
  });
});
