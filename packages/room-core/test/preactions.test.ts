import { describe, expect, it } from 'vitest';
import { AUTO_FOLD_AFTER_MS, type Command, type PreAction } from '@feltcircle/game-protocol';
import {
  applyCommand,
  connectSeat,
  createOnlineRoom,
  disconnectSeat,
  joinSeat,
  normalizeRoom,
  tick,
  toView,
  type RoomState,
} from '../src/index.js';

const now = 3_000_000;
let ids = 0;
function cmd(state: RoomState, seat: number, c: Command, id = `p${++ids}`) {
  return applyCommand(state, { seat }, c, now, id);
}
function ok(state: RoomState, seat: number, c: Command, id?: string) {
  const r = cmd(state, seat, c, id);
  if (!r.ok) throw new Error(`${c.type} failed: ${r.error}`);
  return r.state;
}
const pre = (preAction: PreAction | null, hand?: number): Command =>
  hand === undefined ? { type: 'setPreAction', preAction } : { type: 'setPreAction', preAction, hand };
const raise = (amount: number): Command => ({ type: 'act', action: { type: 'raise', amount } });
const call: Command = { type: 'act', action: { type: 'call' } };
const fold: Command = { type: 'act', action: { type: 'fold' } };

/**
 * Three connected players, game started: dealer 1, SB 2, BB 3; seat 1 acts
 * first. The big blind (seat 3) owes nothing until someone raises.
 */
function started(chips?: Record<number, number>): RoomState {
  let s = createOnlineRoom({ id: 'PREAC', hostToken: 't1', hostNickname: 'Host', now, settings: { maxPlayers: 6, startingChips: 1000 } });
  s = connectSeat(s, 1, now);
  for (const seat of [2, 3]) {
    s = joinSeat(s, seat, `P${seat}`, `t${seat}`, now);
    s = connectSeat(s, seat, now);
  }
  if (chips) s = ok(s, 1, { type: 'host:import', seats: chips, resolution: null });
  return ok(s, 1, { type: 'host:start' });
}
const seat = (s: RoomState, n: number) => s.game!.hand!.seats.find((x) => x.seat === n)!;
const lastLog = (s: RoomState) => s.game!.hand!.log.at(-1)!;

describe('pre-actions when checking is legal (amount owed = 0)', () => {
  it('offers Check/Fold, Check and Call Any; the standalone Fold is refused', () => {
    const s = started();
    expect(cmd(s, 3, pre('fold')).error).toBe('PRE_ACTION_UNAVAILABLE');
    for (const p of ['checkfold', 'check', 'callany'] as const) expect(cmd(s, 3, pre(p)).ok).toBe(true);
    // The small blind owes 10: Fold is offered, Check is not.
    expect(cmd(s, 2, pre('check')).error).toBe('PRE_ACTION_UNAVAILABLE');
    expect(cmd(s, 2, pre('fold')).ok).toBe(true);
  });

  it.each(['checkfold', 'check', 'callany'] as const)('%s checks automatically when nobody raises, once', (p) => {
    let s = ok(started(), 3, pre(p));
    s = ok(s, 1, call);
    s = ok(s, 2, call);
    expect(lastLog(s)).toMatchObject({ seat: 3, type: 'check', auto: true });
    expect(s.game!.hand!.street).toBe('flop'); // the flop started right away
    expect(s.preActions).toEqual({});
    expect(s.game!.hand!.log.filter((e) => e.seat === 3 && e.auto)).toHaveLength(1);
  });
});

describe('pre-actions when a call becomes necessary', () => {
  it('Check/Fold folds', () => {
    let s = ok(started(), 3, pre('checkfold'));
    s = ok(s, 1, raise(60));
    expect(s.preActions[3]).toBe('checkfold'); // still on offer while chips are owed
    s = ok(s, 2, call);
    expect(seat(s, 3).folded).toBe(true);
    expect(lastLog(s)).toMatchObject({ seat: 3, type: 'fold', auto: true });
  });

  it('Check is cancelled with a notice: it never folds or calls, and the player decides', () => {
    let s = ok(started(), 3, pre('check'));
    s = ok(s, 1, raise(60));
    // Cancelled as soon as the raise makes a call necessary, before the turn arrives.
    expect(s.preActions[3]).toBeUndefined();
    expect(s.preActionNotices[3]).toBe('checkCanceled');
    expect(toView(s, 3, now).preActionNotice).toBe('checkCanceled');
    expect(toView(s, 3, now).myPreAction).toBe(null);
    expect(toView(s, 2, now).preActionNotice).toBe(null); // private to the player
    s = ok(s, 2, call);
    expect(s.game!.hand!.toAct).toBe(3);
    expect(seat(s, 3).folded).toBe(false);
    expect(seat(s, 3).bet).toBe(20);
    expect(s.game!.hand!.log.some((e) => e.seat === 3 && e.auto)).toBe(false);
    // Cancelling does not start any extra timer or auto-fold.
    const later = tick(s, now + AUTO_FOLD_AFTER_MS * 10);
    expect(later.changed).toBe(false);
    expect(s.seats[3].autoFold).toBe(false);
    // The notice disappears once the player acts.
    s = ok(s, 3, call);
    expect(s.preActionNotices).toEqual({});
    expect(toView(s, 3, now).preActionNotice).toBe(null);
  });

  it('choosing again after the cancellation clears the notice', () => {
    let s = ok(started(), 3, pre('check'));
    s = ok(s, 1, raise(60));
    s = ok(s, 3, pre('callany'));
    expect(s.preActionNotices[3]).toBeUndefined();
    s = ok(s, 2, call);
    expect(lastLog(s)).toMatchObject({ seat: 3, type: 'call', auto: true });
  });

  it('Call Any follows an increased call amount', () => {
    let s = ok(started(), 3, pre('callany'));
    s = ok(s, 1, raise(60));
    s = ok(s, 2, raise(200));
    expect(seat(s, 3).bet).toBe(200);
    expect(lastLog(s)).toMatchObject({ seat: 3, type: 'call', auto: true });
    expect(s.preActions).toEqual({});
  });

  it('Call Any calls with the remaining stack when the bet is larger (all-in)', () => {
    let s = started({ 1: 1000, 2: 1000, 3: 300 });
    s = ok(s, 3, pre('callany'));
    s = ok(s, 1, raise(600));
    s = ok(s, 2, fold);
    const p3 = seat(s, 3);
    expect(p3.allIn).toBe(true);
    expect(p3.stack).toBe(0);
    // Called the remaining 280 on top of the 20 big blind (betting is closed, so the street has moved on).
    expect(s.game!.hand!.log.filter((e) => e.seat === 3 && e.auto)).toMatchObject([{ type: 'call', auto: true }]);
    expect(s.game!.hand!.startStacks[3]).toBe(300);
  });
});

describe('selection lifecycle', () => {
  it('can be switched and cancelled before it runs', () => {
    let s = ok(started(), 3, pre('check'));
    s = ok(s, 3, pre('callany'));
    expect(toView(s, 3, now).myPreAction).toBe('callany');
    s = ok(s, 3, pre('checkfold'));
    expect(s.preActions[3]).toBe('checkfold');
    s = ok(s, 3, pre(null));
    expect(s.preActions[3]).toBeUndefined();
    s = ok(s, 1, raise(60));
    s = ok(s, 2, call);
    // Nothing selected: seat 3 decides manually.
    expect(s.game!.hand!.toAct).toBe(3);
    expect(seat(s, 3).folded).toBe(false);
  });

  it('runs once and does not repeat on the next street', () => {
    let s = ok(started(), 3, pre('callany'));
    s = ok(s, 1, call);
    s = ok(s, 2, call);
    expect(s.preActions).toEqual({});
    // Flop (started automatically): seat 2 acts first, then 3, who has nothing selected any more.
    s = ok(s, 2, { type: 'act', action: { type: 'bet', amount: 40 } });
    expect(s.game!.hand!.toAct).toBe(3);
    expect(seat(s, 3).bet).toBe(0);
  });

  it('can be chosen at the start of the next street and runs there', () => {
    let s = ok(started(), 1, call);
    s = ok(s, 2, call);
    s = ok(s, 3, { type: 'act', action: { type: 'check' } });
    expect(s.game!.hand!).toMatchObject({ phase: 'betting', street: 'flop', toAct: 2 });
    // Nothing is owed on the new street: Check is on offer, Fold is not.
    expect(cmd(s, 1, pre('fold')).error).toBe('PRE_ACTION_UNAVAILABLE');
    s = ok(s, 3, pre('check'));
    s = ok(s, 2, { type: 'act', action: { type: 'check' } });
    expect(lastLog(s)).toMatchObject({ seat: 3, type: 'check', auto: true });
  });

  it('is cleared when the hand ends and never carried into the next hand', () => {
    let s = ok(started(), 3, pre('check'));
    s = ok(s, 2, pre('checkfold'));
    s = ok(s, 1, fold);
    // Seat 2's Check/Fold folds (10 owed); seat 3 wins: the hand is over.
    expect(s.game!.hand!.phase).toBe('complete');
    expect(s.preActions).toEqual({});
    expect(s.preActionNotices).toEqual({});
    s = ok(s, 1, { type: 'host:nextHand' });
    expect(s.preActions).toEqual({});
    expect(toView(s, 3, now).myPreAction).toBe(null);
  });

  it('a cancelled-Check notice does not survive the hand', () => {
    // A notice for a player who never had to act again (set directly: in play
    // the player with a cancelled Check normally acts next, which clears it).
    let s = started();
    s = { ...s, preActionNotices: { 3: 'checkCanceled' } };
    s = ok(s, 1, fold);
    s = ok(s, 2, fold);
    expect(s.game!.hand!.phase).toBe('complete');
    expect(s.preActionNotices).toEqual({});
  });

  it('is cleared when the player sits out', () => {
    let s = ok(started(), 3, pre('callany'));
    s = ok(s, 3, { type: 'setAway', away: true });
    expect(s.preActions).toEqual({});
  });

  it('is cleared by the host undoing an action', () => {
    let s = ok(started(), 1, call);
    s = ok(s, 3, pre('check'));
    s = ok(s, 1, { type: 'host:undo' });
    expect(s.preActions).toEqual({});
  });
});

describe('stale and repeated messages', () => {
  it('rejects a selection meant for an earlier hand (delayed or resent after a reconnect)', () => {
    let s = ok(started(), 1, fold);
    s = ok(s, 2, fold);
    s = ok(s, 1, { type: 'host:nextHand' });
    expect(s.game!.hand!.number).toBe(2);
    // Hand 2: dealer 2, SB 3, BB 1; seat 2 acts first. Seat 1 (BB) owes nothing.
    expect(cmd(s, 1, pre('callany', 1)).error).toBe('PRE_ACTION_UNAVAILABLE');
    s = ok(s, 1, pre('check', 2));
    // A stale "clear" from hand 1 does not remove the hand-2 selection either.
    s = ok(s, 1, pre(null, 1));
    expect(s.preActions[1]).toBe('check');
  });

  it('applies a repeated command id once: a resent selection cannot come back after cancelling', () => {
    let s = ok(started(), 3, pre('callany'), 'sel-1');
    s = ok(s, 3, pre(null), 'clr-1');
    const again = cmd(s, 3, pre('callany'), 'sel-1');
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(again.state.preActions[3]).toBeUndefined();
  });

  it('checks the selection against the authoritative hand, not the client view', () => {
    let s = started();
    s = ok(s, 1, raise(60));
    // The client still showed "nothing owed" and sends Check: refused.
    expect(cmd(s, 3, pre('check')).error).toBe('PRE_ACTION_UNAVAILABLE');
  });

  it('survives a short disconnect and reconnect; the long-disconnect auto-fold still overrides it', () => {
    let s = ok(started(), 3, pre('check'));
    s = disconnectSeat(s, 3, now);
    s = connectSeat(s, 3, now + 1000);
    expect(toView(s, 3, now).myPreAction).toBe('check');
    s = ok(s, 1, call);
    s = ok(s, 2, call);
    expect(lastLog(s)).toMatchObject({ seat: 3, type: 'check', auto: true });

    let t = ok(started(), 3, pre('check'));
    t = disconnectSeat(t, 3, now);
    t = tick(t, now + AUTO_FOLD_AFTER_MS).state;
    expect(t.preActions).toEqual({});
    t = ok(t, 1, raise(60));
    t = ok(t, 2, call);
    expect(seat(t, 3).folded).toBe(true); // existing disconnect timeout behaviour
  });

  it('keeps Check and Check/Fold distinct in stored state; old stored rooms load', () => {
    const s = ok(ok(started(), 3, pre('check')), 2, pre('checkfold'));
    const stored = JSON.parse(JSON.stringify(s)) as RoomState;
    expect(stored.preActions).toEqual({ 2: 'checkfold', 3: 'check' });
    const old = JSON.parse(JSON.stringify(s)) as Partial<RoomState>;
    delete old.preActionNotices;
    const loaded = normalizeRoom(old as RoomState);
    expect(loaded.preActionNotices).toEqual({});
    expect(loaded.preActions).toEqual({ 2: 'checkfold', 3: 'check' });
  });
});
