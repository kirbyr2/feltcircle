import { describe, expect, it } from 'vitest';
import {
  beginShowdown,
  awardPots,
  createTournament,
  currentPots,
  defaultConfig,
  EngineError,
  levelFor,
  muck,
  playersPerLevelFor,
  seatPlayer,
  setSeatChips,
  startHand,
  totalChips,
  validateConfig,
  type TournamentState,
} from '../src/index.js';
import { allin, begin, call, check, fold, play, seat, table } from './helpers.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as EngineError).code;
  }
  return 'NO_ERROR';
};

/** Check down every street until showdown. */
function toShowdown(t: TournamentState): TournamentState {
  while (t.hand!.phase !== 'showdown') {
    if (t.hand!.phase === 'reveal') t = beginShowdown(t);
    else t = play(t, [[t.hand!.toAct!, t.hand!.currentBet > seat(t, t.hand!.toAct!).bet ? call : check]]);
  }
  return t;
}

describe('blind configuration', () => {
  it('requires the big blind to exceed the small blind', () => {
    expect(validateConfig(defaultConfig({ sb: 20, bb: 20 }))).toBe('levels');
    expect(validateConfig(defaultConfig({ sb: 10, bb: 20 }))).toBe(null);
  });

  it('fixed blinds never increase automatically', () => {
    const t = createTournament({ config: defaultConfig({ progression: 'fixed' }), chips: { 1: 2000, 2: 2000, 3: 0 }, now: 0 });
    t.startPlayerCount = 3;
    expect(levelFor(t, 10 * 60 * 60_000)).toBe(0);
  });

  it('derives eliminations per level from the table size', () => {
    expect([2, 3, 6, 7, 8, 10].map(playersPerLevelFor)).toEqual([1, 1, 1, 1, 2, 2]);
  });
});

describe('late joiners and chip adjustments', () => {
  it('a late joiner is dealt in from the next hand without touching the current one', () => {
    let t = begin({ 1: 2000, 2: 2000, 3: 2000 });
    const before = structuredClone(t.hand);
    t = seatPlayer(t, 5, 1500);
    expect(t.hand).toEqual(before);
    expect(t.chips[5]).toBe(1500);
    expect(t.seats).toEqual([1, 2, 3, 5]);
    t = play(t, [[t.hand!.toAct!, fold]]);
    t = play(t, [[t.hand!.toAct!, fold]]);
    t = startHand(t, 0);
    expect(t.hand!.seats.map((s) => s.seat)).toEqual([1, 2, 3, 5]);
  });

  it('rejects seats that are still playing and non-positive amounts', () => {
    const t = begin({ 1: 2000, 2: 2000 });
    expect(code(() => seatPlayer(t, 1, 100))).toBe('INVALID_SEAT');
    expect(code(() => seatPlayer(t, 3, 0))).toBe('INVALID_AMOUNT');
  });

  it('allows any chip total (no fixed supply)', () => {
    let t = table({ 1: 2000, 2: 2000 });
    t = seatPlayer(t, 3, 50_000);
    expect(totalChips(t)).toBe(54_000);
  });

  it('adjusts balances between hands only and can revive a finished game', () => {
    let t = begin({ 1: 1000, 2: 1000 });
    expect(code(() => setSeatChips(t, 1, 5))).toBe('HAND_IN_PROGRESS');
    t = play(t, [[1, allin], [2, call]]);
    t = toShowdown(t);
    t = awardPots(t, [[2]]);
    expect(t.finished).toBe(true);
    t = setSeatChips(t, 1, 800);
    expect(t.finished).toBe(false);
    expect(t.chips).toEqual({ 1: 800, 2: 2000 });
    expect(t.eliminations).toEqual([]);
    t = startHand(t, 0);
    expect(t.hand!.number).toBe(2);
  });
});

describe('mucking at showdown', () => {
  it('a mucked player loses eligibility; last contender per pot is settled automatically', () => {
    // A (1) all-in 100; B (2) and C (3) put in 300 each.
    let t = begin({ 1: 100, 2: 1000, 3: 1000 }, { firstDealer: 3 });
    // Dealer 3 → SB 1, BB 2; preflop order: 3, 1, 2.
    t = play(t, [[3, { type: 'raise', amount: 300 }], [1, allin], [2, call]]);
    t = toShowdown(t);
    expect(currentPots(t.hand!)).toEqual([
      { amount: 300, eligible: [1, 2, 3] },
      { amount: 400, eligible: [2, 3] },
    ]);
    t = muck(t, 2);
    expect(t.hand!.phase).toBe('showdown'); // main pot still has two contenders
    expect(currentPots(t.hand!)).toEqual([
      { amount: 300, eligible: [1, 3] },
      { amount: 400, eligible: [3] },
    ]);
    t = muck(t, 1);
    expect(t.hand!.phase).toBe('complete');
    expect(t.chips).toEqual({ 1: 0, 2: 700, 3: 1400 });
  });

  it('cannot muck as the only contender of a pot', () => {
    let t = begin({ 1: 100, 2: 1000, 3: 1000 }, { firstDealer: 3 });
    t = play(t, [[3, { type: 'raise', amount: 300 }], [1, allin], [2, call]]);
    t = toShowdown(t);
    t = muck(t, 2);
    // C is now the only contender for the side pot.
    expect(code(() => muck(t, 3))).toBe('CANNOT_MUCK');
    expect(code(() => muck(t, 2))).toBe('ILLEGAL_ACTION');
    expect(code(() => muck(begin({ 1: 100, 2: 100 }), 1))).toBe('WRONG_PHASE');
  });
});
