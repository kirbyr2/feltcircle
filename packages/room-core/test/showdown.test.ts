import { describe, expect, it } from 'vitest';
import { SHOWDOWN_FOLD_MS, type Command } from '@feltcircle/game-protocol';
import { streetToDeal, totalChips } from '@feltcircle/poker-engine';
import {
  applyCommand,
  connectSeat,
  createLocalRoom,
  createOnlineRoom,
  joinSeat,
  nextTimerAt,
  nextWakeAt,
  normalizeRoom,
  requestSeat,
  tick,
  toView,
  type RoomState,
} from '../src/index.js';

const T0 = 10_000_000;
let ids = 0;
function cmd(s: RoomState, seat: number | null, c: Command, at = T0, id = `s${++ids}`) {
  return applyCommand(s, seat === null ? { seat: null, local: true } : { seat }, c, at, id);
}
function ok(s: RoomState, seat: number | null, c: Command, at = T0, id?: string) {
  const r = cmd(s, seat, c, at, id);
  if (!r.ok) throw new Error(`${c.type} failed: ${r.error}`);
  return r.state;
}
const act = (type: 'fold' | 'check' | 'call' | 'allin'): Command => ({ type: 'act', action: { type } });
const bet = (amount: number): Command => ({ type: 'act', action: { type: 'bet', amount } });
const declare = (declaration: 'win' | 'tie' | 'fold' | null, extra: { hand?: number; seat?: number } = {}): Command => ({
  type: 'declare',
  declaration,
  ...extra,
});
const hand = (s: RoomState) => s.game!.hand!;
const seatOf = (s: RoomState, n: number) => hand(s).seats.find((x) => x.seat === n)!;

/** Three connected players (1000 chips each, or `chips`); dealer 1, SB 2, BB 3; seat 1 acts first. */
function started(n = 3, chips?: Record<number, number>): RoomState {
  let s = createOnlineRoom({ id: 'SHOWD', hostToken: 't1', hostNickname: 'Host', now: T0, settings: { maxPlayers: 6, startingChips: 1000 } });
  s = connectSeat(s, 1, T0);
  for (let seat = 2; seat <= n; seat++) s = connectSeat(joinSeat(s, seat, `P${seat}`, `t${seat}`, T0), seat, T0);
  if (chips) s = ok(s, 1, { type: 'host:import', seats: chips, resolution: null });
  return ok(s, 1, { type: 'host:start' });
}

/** Call/check every decision until no more betting is possible. */
function toReveal(s: RoomState): RoomState {
  for (let i = 0; i < 60 && hand(s).phase === 'betting'; i++) {
    const h = hand(s);
    const me = seatOf(s, h.toAct!);
    s = ok(s, h.toAct!, act(me.bet < h.currentBet ? 'call' : 'check'));
  }
  expect(hand(s).phase).toBe('reveal');
  return s;
}

/** Single pot of 60 (20 each), showdown confirmed at T0. */
function atShowdown(): RoomState {
  return ok(toReveal(started()), 1, { type: 'host:showdown' });
}

describe('streets advance without dealing confirmations', () => {
  it('starts the flop, turn and river by itself and says what to deal first', () => {
    let s = started();
    s = ok(s, 1, act('call'));
    s = ok(s, 2, act('call'));
    s = ok(s, 3, act('check'));
    // No host command in between: the flop is open and seat 2 (left of the dealer) acts.
    expect(hand(s)).toMatchObject({ phase: 'betting', street: 'flop', toAct: 2 });
    expect(streetToDeal(hand(s))).toBe('flop');
    s = ok(s, 2, act('check'));
    // Somebody acted on the flop by hand: it has been dealt, no more "deal the flop".
    expect(streetToDeal(hand(s))).toBe(null);
    s = ok(s, 3, act('check'));
    s = ok(s, 1, act('check'));
    expect(hand(s)).toMatchObject({ phase: 'betting', street: 'turn', toAct: 2 });
    expect(streetToDeal(hand(s))).toBe('turn');
  });

  it('an automatic pre-action does not count as the cards being dealt', () => {
    let s = started();
    s = ok(s, 1, act('call'));
    s = ok(s, 2, act('call'));
    s = ok(s, 1, { type: 'setPreAction', preAction: 'check' });
    s = ok(s, 3, act('check')); // flop: 2 to act, 3 next, then 1
    s = ok(s, 3, { type: 'setPreAction', preAction: 'check' });
    s = ok(s, 2, act('check')); // by hand → flop dealt; 3 and 1 check automatically → turn
    expect(hand(s).street).toBe('turn');
    expect(streetToDeal(hand(s))).toBe('turn');
  });

  it('keeps an outstanding call/fold decision against an all-in bet', () => {
    let s = started(3, { 1: 300, 2: 1000, 3: 1000 });
    s = ok(s, 1, act('allin'));
    s = ok(s, 2, act('fold'));
    // Seat 3 still has to decide although only one player can bet.
    expect(hand(s)).toMatchObject({ phase: 'betting', toAct: 3 });
    s = ok(s, 3, act('call'));
    // Now nobody can bet: run out the board and reveal (pre-flop all-in).
    expect(hand(s)).toMatchObject({ phase: 'reveal', street: 'preflop', bettingClosed: true });
  });

  it('keeps betting when one player is all-in but two others can still bet', () => {
    let s = started(3, { 1: 1000, 2: 1000, 3: 15 });
    s = ok(s, 1, act('call'));
    s = ok(s, 2, act('call'));
    expect(hand(s)).toMatchObject({ phase: 'betting', street: 'flop', bettingClosed: false });
  });

  it('needs the one showdown confirmation; nothing can be declared or settled before it', () => {
    let s = toReveal(started());
    expect(hand(s).street).toBe('river'); // river betting finished: the board is complete
    expect(cmd(s, 2, declare('win')).error).toBe('WRONG_PHASE');
    expect(cmd(s, 1, { type: 'host:award', winners: [[2]] }).error).toBe('WRONG_PHASE');
    expect(cmd(s, 2, { type: 'host:showdown' }).error).toBe('NOT_HOST');
    s = ok(s, 1, { type: 'host:showdown' });
    expect(hand(s).phase).toBe('showdown');
    expect(toView(s, 2, T0).showdown).toEqual({ declarations: {}, manual: false, sidePots: false, claimant: null, deadline: null });
  });

  it('awards an uncontested pot during betting without a run-out or confirmation', () => {
    let s = started();
    s = ok(s, 1, { type: 'act', action: { type: 'raise', amount: 100 } });
    s = ok(s, 2, act('fold'));
    s = ok(s, 3, act('fold'));
    expect(hand(s).phase).toBe('complete');
    expect(hand(s).result!.uncontested).toBe(true);
    expect(s.game!.chips).toEqual({ 1: 1030, 2: 990, 3: 980 });
  });

  it('does not start a new hand by itself after settlement', () => {
    let s = atShowdown();
    s = ok(s, 1, { type: 'host:award', winners: [[2]] });
    expect(hand(s).phase).toBe('complete');
    expect(tick(s, T0 + 60_000).changed).toBe(false);
    expect(hand(s).number).toBe(1);
  });
});

describe('one Win declaration: automatic folds', () => {
  it('starts a countdown for every other contender', () => {
    const s = ok(atShowdown(), 2, declare('win'));
    expect(toView(s, 3, T0).showdown).toEqual({ declarations: { 2: 'win' }, manual: false, sidePots: false, claimant: 2, deadline: T0 + SHOWDOWN_FOLD_MS });
    expect(nextTimerAt(s)).toBe(T0 + SHOWDOWN_FOLD_MS);
    expect(nextWakeAt(s)).toBe(T0 + SHOWDOWN_FOLD_MS);
  });

  it('settles at once when everybody else folds voluntarily', () => {
    let s = ok(atShowdown(), 2, declare('win'));
    s = ok(s, 1, declare('fold'), T0 + 1000);
    expect(hand(s).phase).toBe('showdown');
    s = ok(s, 3, declare('fold'), T0 + 2000);
    expect(hand(s).phase).toBe('complete');
    expect(s.game!.chips).toEqual({ 1: 980, 2: 1040, 3: 980 });
    expect(s.showdown).toBe(null);
    expect(nextTimerAt(s)).toBe(null);
  });

  it('folds the others automatically when the deadline passes (and not a moment earlier)', () => {
    const s = ok(atShowdown(), 2, declare('win'));
    expect(tick(s, T0 + SHOWDOWN_FOLD_MS - 1).changed).toBe(false);
    const r = tick(s, T0 + SHOWDOWN_FOLD_MS);
    expect(r.changed).toBe(true);
    const after = r.state;
    expect(hand(after).phase).toBe('complete');
    expect(after.game!.chips).toEqual({ 1: 980, 2: 1040, 3: 980 });
    expect(hand(after).log.filter((e) => e.type === 'muck' && e.auto).map((e) => e.seat)).toEqual([1, 3]);
    expect(after.log.filter((e) => e.code === 'autoFolded').map((e) => e.seat)).toEqual([1, 3]);
    expect(totalChips(after.game!)).toBe(3000);
  });

  it('a mixture: one opponent folds by hand, the other automatically', () => {
    let s = ok(atShowdown(), 2, declare('win'));
    s = ok(s, 3, declare('fold'), T0 + 4000);
    const after = tick(s, T0 + SHOWDOWN_FOLD_MS).state;
    expect(hand(after).log.filter((e) => e.type === 'muck').map((e) => [e.seat, !!e.auto])).toEqual([
      [3, false],
      [1, true],
    ]);
    expect(after.game!.chips[2]).toBe(1040);
  });

  it('settles exactly once: repeated timers, a racing host award and duplicate messages find nothing to do', () => {
    let s = ok(atShowdown(), 2, declare('win'), T0, 'win-1');
    const first = tick(s, T0 + SHOWDOWN_FOLD_MS);
    const again = tick(first.state, T0 + SHOWDOWN_FOLD_MS + 10);
    expect(again.changed).toBe(false);
    expect(cmd(first.state, 1, { type: 'host:award', winners: [[3]] }).error).toBe('WRONG_PHASE');
    // The same Win message delivered again is recognised and ignored.
    expect(cmd(first.state, 2, declare('win'), T0 + 6000, 'win-1')).toMatchObject({ ok: true, duplicate: true });
    s = first.state;
    expect(s.game!.chips).toEqual({ 1: 980, 2: 1040, 3: 980 });
  });

  it('deadline boundary: a conflict just before the deadline cancels; at the deadline it is too late', () => {
    const s = ok(atShowdown(), 2, declare('win'));
    const inTime = ok(s, 3, declare('tie'), T0 + SHOWDOWN_FOLD_MS - 1);
    expect(inTime.showdown).toMatchObject({ manual: true, deadline: null });
    expect(tick(inTime, T0 + SHOWDOWN_FOLD_MS + 1000).changed).toBe(false);
    expect(hand(inTime).phase).toBe('showdown');
    // At the deadline the automatic folds come first; the late declaration is refused.
    expect(cmd(s, 3, declare('tie', { hand: 1 }), T0 + SHOWDOWN_FOLD_MS).error).toBe('WRONG_PHASE');
    expect(hand(tick(s, T0 + SHOWDOWN_FOLD_MS).state).phase).toBe('complete');
  });
});

describe('conflicts hand the decision to the host', () => {
  it('a second Win cancels every countdown; nobody is folded automatically', () => {
    let s = ok(atShowdown(), 2, declare('win'));
    s = ok(s, 3, declare('win'), T0 + 2000);
    expect(toView(s, 1, T0).showdown).toMatchObject({ declarations: { 2: 'win', 3: 'win' }, manual: true, claimant: null, deadline: null });
    expect(tick(s, T0 + 60_000).changed).toBe(false);
    expect(hand(s).phase).toBe('showdown');
  });

  it('a Tie cancels the countdown and never grants a share by itself', () => {
    let s = ok(atShowdown(), 2, declare('win'));
    s = ok(s, 1, declare('tie'), T0 + 1000);
    expect(s.showdown).toMatchObject({ manual: true, deadline: null });
    s = ok(s, 3, declare('fold'), T0 + 2000);
    // Seats 1 (Tie) and 2 (Win) remain: still for the host to decide.
    expect(hand(s).phase).toBe('showdown');
    expect(s.game!.chips).toEqual({ 1: 1000, 2: 1000, 3: 1000 });
    s = ok(s, 1, { type: 'host:award', winners: [[1, 2]] });
    expect(s.game!.chips).toEqual({ 1: 1010, 2: 1010, 3: 980 });
  });

  it('the sole claimant withdrawing (or folding) cancels it as well', () => {
    let s = ok(atShowdown(), 2, declare('win'));
    s = ok(s, 2, declare(null), T0 + 1000);
    expect(s.showdown).toMatchObject({ manual: true, deadline: null, declarations: {} });
    let t = ok(atShowdown(), 2, declare('win'));
    t = ok(t, 2, declare('fold'), T0 + 1000);
    expect(t.showdown).toMatchObject({ manual: true, deadline: null });
    expect(hand(t).phase).toBe('showdown');
  });

  it('never restarts the countdown in the same showdown, even if declarations change back', () => {
    let s = ok(atShowdown(), 2, declare('win'));
    s = ok(s, 3, declare('win'), T0 + 1000);
    s = ok(s, 3, declare(null), T0 + 2000);
    expect(s.showdown).toMatchObject({ declarations: { 2: 'win' }, manual: true, deadline: null });
    expect(nextTimerAt(s)).toBe(null);
  });

  it('a Tie before any Win, or two Wins at once, also means host judgment', () => {
    let s = ok(atShowdown(), 1, declare('tie'));
    s = ok(s, 1, declare(null));
    s = ok(s, 2, declare('win'));
    expect(s.showdown).toMatchObject({ manual: true, deadline: null });
  });

  it('nobody declaring Win leaves it to the host; the host may settle at any time', () => {
    let s = atShowdown();
    expect(toView(s, 1, T0).showdown!.manual).toBe(false);
    s = ok(s, 1, { type: 'host:award', winners: [[3]] });
    expect(s.game!.chips[3]).toBe(1040);
  });

  it('side pots: no automatic flow at all; the host settles each pot', () => {
    let s = started(3, { 1: 100, 2: 1000, 3: 1000 });
    s = ok(s, 1, act('allin'));
    s = ok(s, 2, act('call'));
    s = ok(s, 3, act('call'));
    s = ok(s, 2, bet(200)); // flop
    s = ok(s, 3, act('call'));
    s = ok(toReveal(s), 1, { type: 'host:showdown' });
    s = ok(s, 2, declare('win'));
    expect(toView(s, 1, T0).showdown).toMatchObject({ manual: true, sidePots: true, deadline: null, claimant: null });
    expect(tick(s, T0 + 60_000).changed).toBe(false);
    expect(cmd(s, 1, { type: 'host:award', winners: [[2], [1]] }).error).toBe('INVALID_WINNERS'); // seat 1 is not in the side pot
    s = ok(s, 1, { type: 'host:award', winners: [[1], [3]] });
    expect(s.game!.chips).toEqual({ 1: 300, 2: 700, 3: 1100 });
    expect(totalChips(s.game!)).toBe(2100);
  });
});

describe('who may declare', () => {
  it('all-in players yes; folded players, spectators and late joiners no', () => {
    let s = started(3, { 1: 100, 2: 1000, 3: 1000 });
    s = ok(s, 1, act('allin'));
    s = ok(s, 2, act('call'));
    s = ok(s, 3, act('fold'));
    s = requestSeat(s, 4, 'Late', 't4', T0);
    s = ok(s, 1, { type: 'host:approveJoin', seat: 4, chips: 500 });
    s = connectSeat(s, 4, T0);
    s = ok(s, 1, { type: 'host:showdown' });
    expect(cmd(s, 1, declare('win')).ok).toBe(true); // all-in
    expect(cmd(s, 3, declare('win')).error).toBe('NOT_ELIGIBLE'); // folded during betting
    expect(cmd(s, 4, declare('win')).error).toBe('NOT_ELIGIBLE'); // waiting for the next hand
    expect(applyCommand(s, { seat: null }, declare('win'), T0).error).toBe('NOT_SEATED'); // spectator
    s = ok(s, 2, declare('fold'));
    expect(cmd(s, 2, declare('win')).error).toBe('WRONG_PHASE'); // settled: seat 1 was the last contender
  });

  it('rejects a declaration meant for an earlier hand', () => {
    let s = ok(atShowdown(), 1, { type: 'host:award', winners: [[2]] });
    s = ok(s, 1, { type: 'host:nextHand' });
    s = ok(ok(toReveal(s), 1, { type: 'host:showdown' }), 1, { type: 'host:pause' });
    s = ok(s, 1, { type: 'host:resume' });
    expect(cmd(s, 2, declare('win', { hand: 1 })).error).toBe('HAND_CHANGED');
    expect(cmd(s, 2, declare('win', { hand: 2 })).ok).toBe(true);
  });
});

describe('host actions, persistence and timers', () => {
  it('host settlement during the countdown clears the timer', () => {
    let s = ok(atShowdown(), 2, declare('win'));
    s = ok(s, 1, { type: 'host:award', winners: [[3]] }, T0 + 1000);
    expect(s.game!.chips[3]).toBe(1040);
    expect(s.showdown).toBe(null);
    expect(nextTimerAt(s)).toBe(null);
    expect(tick(s, T0 + SHOWDOWN_FOLD_MS).changed).toBe(false);
  });

  it('undo after an automatic settlement returns to a host-judged showdown; undo before it cancels the timer', () => {
    let s = ok(atShowdown(), 2, declare('win'));
    s = tick(s, T0 + SHOWDOWN_FOLD_MS).state;
    s = ok(s, 1, { type: 'host:undo' }, T0 + 6000);
    expect(hand(s).phase).toBe('showdown');
    expect(s.showdown).toEqual({ hand: 1, declarations: {}, manual: true, claimant: null, deadline: null });
    expect(s.game!.chips).toEqual({ 1: 1000, 2: 1000, 3: 1000 });

    let t = ok(atShowdown(), 2, declare('win'));
    t = ok(t, 1, { type: 'host:undo' }, T0 + 1000); // undo the showdown confirmation
    expect(hand(t).phase).toBe('reveal');
    expect(t.showdown).toBe(null);
    expect(nextTimerAt(t)).toBe(null);
  });

  it('pausing cancels the countdown for good', () => {
    let s = ok(atShowdown(), 2, declare('win'));
    s = ok(s, 1, { type: 'host:pause' }, T0 + 1000);
    s = ok(s, 1, { type: 'host:resume' }, T0 + 2000);
    expect(s.showdown).toMatchObject({ manual: true, deadline: null });
    expect(tick(s, T0 + 60_000).changed).toBe(false);
  });

  it('the deadline is stored with the room and still fires after a reload', () => {
    const s = ok(atShowdown(), 2, declare('win'));
    const reloaded = normalizeRoom(JSON.parse(JSON.stringify(s)) as RoomState);
    expect(reloaded.showdown).toEqual(s.showdown);
    expect(nextWakeAt(reloaded)).toBe(T0 + SHOWDOWN_FOLD_MS);
    // Woken late (e.g. after a restart): expiry still happens once.
    const r = tick(reloaded, T0 + 60_000);
    expect(hand(r.state).phase).toBe('complete');
    expect(r.state.game!.chips[2]).toBe(1040);
  });

  it('pre-actions and showdown do not mix: selections are gone once betting ends', () => {
    let s = started();
    s = ok(s, 1, act('call'));
    s = ok(s, 3, { type: 'setPreAction', preAction: 'check' });
    s = toReveal(ok(s, 2, act('call')));
    expect(s.preActions).toEqual({});
  });
});

describe('Local Mode', () => {
  it('runs the same rules on the device: declarations per seat and the countdown via tick', () => {
    let s: RoomState = createLocalRoom({ players: [{ seat: 1 }, { seat: 2 }, { seat: 3 }], now: T0 });
    s = ok(s, null, { type: 'host:start' });
    for (let i = 0; i < 60 && hand(s).phase === 'betting'; i++) {
      const h = hand(s);
      const me = seatOf(s, h.toAct!);
      s = ok(s, null, { type: 'act', seat: h.toAct!, action: { type: me.bet < h.currentBet ? 'call' : 'check' } });
    }
    s = ok(s, null, { type: 'host:showdown' });
    s = ok(s, null, declare('win', { seat: 3 }));
    expect(nextTimerAt(s)).toBe(T0 + SHOWDOWN_FOLD_MS);
    expect(nextWakeAt(s)).toBe(null); // no server: the device schedules it
    s = ok(s, null, declare('fold', { seat: 1 }), T0 + 1000);
    const r = tick(s, T0 + SHOWDOWN_FOLD_MS);
    expect(hand(r.state).phase).toBe('complete');
    expect(r.state.game!.chips[3]).toBe(2040);
  });
});

describe('rooms stored by the previous version', () => {
  it('continue a hand that waited for "cards dealt" and keep old claims as Win declarations', () => {
    let s = started();
    s = ok(s, 1, act('call'));
    s = ok(s, 2, act('call'));
    s = ok(s, 3, act('check'));
    // Rewind to how the previous version stored it: waiting between pre-flop and flop.
    const legacy = JSON.parse(JSON.stringify(s)) as RoomState & { claims?: number[] };
    Object.assign(legacy.game!.hand!, { phase: 'street-complete', street: 'preflop', toAct: null });
    delete (legacy as Partial<RoomState>).showdown;
    legacy.claims = [];
    const up = normalizeRoom(legacy);
    expect(up.game!.hand).toMatchObject({ phase: 'betting', street: 'flop', toAct: 2 });

    const atSd = JSON.parse(JSON.stringify(atShowdown())) as RoomState & { claims?: number[] };
    delete (atSd as Partial<RoomState>).showdown;
    atSd.claims = [2];
    expect(normalizeRoom(atSd).showdown).toEqual({ hand: 1, declarations: { 2: 'win' }, manual: true, claimant: null, deadline: null });
  });
});
