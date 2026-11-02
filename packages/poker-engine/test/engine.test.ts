import { describe, expect, it } from 'vitest';
import {
  beginShowdown,
  applyAction,
  awardPots,
  computePositions,
  computePots,
  createTournament,
  currentPots,
  defaultConfig,
  displayPots,
  EngineError,
  legalActions,
  levelFor,
  pauseClock,
  resetChips,
  resumeClock,
  splitPot,
  startHand,
  totalChips,
  type TournamentState,
} from '../src/index.js';
import { allin, begin, bet, call, check, fold, play, raise, seat, table } from './helpers.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as EngineError).code;
  }
  return 'NO_ERROR';
};

describe('positions and dealer rotation', () => {
  it('assigns dealer, SB, BB clockwise for 3+ players and skips empty seats', () => {
    expect(computePositions([1, 3, 4, 7], null, 1)).toEqual({ dealer: 1, sbSeat: 3, bbSeat: 4 });
    expect(computePositions([1, 3, 4, 7], 4, 1)).toEqual({ dealer: 3, sbSeat: 4, bbSeat: 7 });
    expect(computePositions([1, 3, 4, 7], 7, 1)).toEqual({ dealer: 4, sbSeat: 7, bbSeat: 1 });
  });

  it('heads-up: dealer posts small blind', () => {
    expect(computePositions([2, 5], null, 2)).toEqual({ dealer: 2, sbSeat: 2, bbSeat: 5 });
    expect(computePositions([2, 5], 5, 2)).toEqual({ dealer: 5, sbSeat: 5, bbSeat: 2 });
  });

  it('nobody posts the big blind twice in a row when moving to heads-up', () => {
    // Last hand: 1=D 2=SB 3=BB. Seat 1 busts.
    const p = computePositions([2, 3], 3, 1);
    expect(p.bbSeat).toBe(2);
    expect(p.dealer).toBe(3);
    expect(p.sbSeat).toBe(3);
  });

  it('rotates the button each hand', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 1000, 4: 1000 });
    const dealers: number[] = [];
    for (let i = 0; i < 5; i++) {
      dealers.push(t.hand!.dealer);
      // everyone folds to big blind
      while (t.hand!.phase === 'betting') t = applyAction(t, t.hand!.toAct!, fold);
      t = startHand(t, 0);
    }
    expect(dealers).toEqual([1, 2, 3, 4, 1]);
  });
});

describe('blind posting and turn order', () => {
  it('posts blinds and starts preflop action left of the big blind', () => {
    const t = begin({ 1: 1000, 2: 1000, 3: 1000, 4: 1000 });
    const h = t.hand!;
    expect([h.dealer, h.sbSeat, h.bbSeat]).toEqual([1, 2, 3]);
    expect(seat(t, 2).bet).toBe(10);
    expect(seat(t, 3).bet).toBe(20);
    expect(seat(t, 2).stack).toBe(990);
    expect(h.toAct).toBe(4);
    expect(h.currentBet).toBe(20);
  });

  it('post-flop action starts left of the dealer', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 1000, 4: 1000 });
    t = play(t, [[4, call], [1, call], [2, call], [3, check]]);
    // No host confirmation: the flop starts at once (cards are dealt physically).
    expect(t.hand!.phase).toBe('betting');
    expect(t.hand!.street).toBe('flop');
    expect(t.hand!.toAct).toBe(2);
  });

  it('heads-up: dealer acts first preflop, big blind first post-flop', () => {
    let t = begin({ 1: 1000, 2: 1000 });
    expect(t.hand!.dealer).toBe(1);
    expect(t.hand!.sbSeat).toBe(1);
    expect(t.hand!.toAct).toBe(1);
    t = play(t, [[1, call], [2, check]]);
    expect(t.hand!.street).toBe('flop');
    expect(t.hand!.toAct).toBe(2);
  });

  it('big blind gets the option when everyone limps', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 1000 });
    t = play(t, [[1, call], [2, call]]);
    expect(t.hand!.toAct).toBe(3);
    const legal = legalActions(t.hand!, 3)!;
    expect(legal.canCheck).toBe(true);
    expect(legal.aggressive).toBe('raise');
    t = play(t, [[3, raise(60)]]);
    expect(t.hand!.toAct).toBe(1);
  });

  it('short-stacked big blind is all-in, others still owe a full big blind', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 15 });
    expect(seat(t, 3).allIn).toBe(true);
    expect(t.hand!.currentBet).toBe(20);
    t = play(t, [[1, call], [2, call]]);
    // Two players can still bet, so the flop is played even though the big blind is all-in.
    expect(t.hand!.phase).toBe('betting');
    expect(t.hand!.street).toBe('flop');
    const pots = currentPots(t.hand!);
    expect(pots).toEqual([
      { amount: 45, eligible: [1, 2, 3] },
      { amount: 10, eligible: [1, 2] },
    ]);
  });

  it('rejects out-of-turn actions', () => {
    const t = begin({ 1: 1000, 2: 1000, 3: 1000 });
    expect(code(() => applyAction(t, 2, call))).toBe('NOT_YOUR_TURN');
  });
});

describe('bet sizing', () => {
  it('enforces minimum opening bet and minimum raise', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 1000 });
    expect(code(() => applyAction(t, 1, raise(30)))).toBe('BET_TOO_SMALL');
    expect(legalActions(t.hand!, 1)!.minTo).toBe(40);
    t = play(t, [[1, raise(70)]]); // raise of 50
    expect(legalActions(t.hand!, 2)!.minTo).toBe(120);
    expect(code(() => applyAction(t, 2, raise(110)))).toBe('BET_TOO_SMALL');
    t = play(t, [[2, fold], [3, call]]);
    // Post-flop min bet is the big blind.
    expect(legalActions(t.hand!, 3)!.aggressive).toBe('bet');
    expect(legalActions(t.hand!, 3)!.minTo).toBe(20);
    expect(code(() => applyAction(t, 3, raise(40)))).toBe('ILLEGAL_ACTION');
    expect(code(() => applyAction(t, 3, bet(10)))).toBe('BET_TOO_SMALL');
    expect(code(() => applyAction(t, 3, bet(5000)))).toBe('BET_TOO_LARGE');
    expect(code(() => applyAction(t, 3, bet(25.5)))).toBe('INVALID_AMOUNT');
  });

  it('allows a short all-in below the minimum raise', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 50 });
    t = play(t, [[1, raise(40)], [2, call]]);
    // seat 3 (BB) has 30 behind; all-in to 50 is a short raise (+10 < 20).
    t = play(t, [[3, allin]]);
    expect(t.hand!.currentBet).toBe(50);
    expect(t.hand!.minRaise).toBe(20);
  });

  it('chip-check: calls exceeding stack become all-in calls', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 100 });
    t = play(t, [[1, raise(500)], [2, fold]]);
    const legal = legalActions(t.hand!, 3)!;
    expect(legal.callAmount).toBe(80);
    expect(legal.callIsAllIn).toBe(true);
    expect(legal.aggressive).toBe(null);
    t = play(t, [[3, call]]);
    expect(seat(t, 3).allIn).toBe(true);
  });
});

describe('action reopening', () => {
  it('short all-in raise: earlier callers may only call or fold', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 1000, 4: 130 });
    // UTG(4) is short. 4 limps? Instead: 4 folds… set up: 1 raises to 100.
    t = play(t, [[4, call], [1, raise(100)], [2, fold], [3, call]]);
    // 4 has 110 behind with 20 in; all-in to 130 is a raise of 30 (< 80 full raise).
    t = play(t, [[4, allin]]);
    expect(t.hand!.currentBet).toBe(130);
    expect(t.hand!.toAct).toBe(1);
    const l1 = legalActions(t.hand!, 1)!;
    expect(l1.aggressive).toBe(null);
    expect(l1.callAmount).toBe(30);
    expect(code(() => applyAction(t, 1, raise(300)))).toBe('ILLEGAL_ACTION');
  });

  it('a full raise reopens the action', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 1000, 4: 1000 });
    t = play(t, [[4, call], [1, call], [2, call], [3, raise(60)]]);
    const l4 = legalActions(t.hand!, 4)!;
    expect(l4.aggressive).toBe('raise');
    expect(l4.minTo).toBe(100);
  });

  it('multiple short all-ins that add up to a full raise reopen the action', () => {
    // 4 short stacks to create two consecutive short raises.
    let t = begin({ 1: 1000, 2: 150, 3: 1000, 4: 1000, 5: 190 }, { firstDealer: 5 });
    // dealer 5, SB 1, BB 2, UTG 3
    expect([t.hand!.dealer, t.hand!.sbSeat, t.hand!.bbSeat]).toEqual([5, 1, 2]);
    t = play(t, [[3, raise(100)], [4, call], [5, allin]]); // 190: +90 (full raise is 80 → full!)
    expect(t.hand!.minRaise).toBe(90);
    t = play(t, [[1, fold], [2, allin]]); // 150 < 190 → just an all-in call
    expect(t.hand!.toAct).toBe(3);
    expect(legalActions(t.hand!, 3)!.aggressive).toBe('raise');
  });

  it('cumulative short raises totalling a full raise reopen betting', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 150, 4: 200 }, { firstDealer: 1 });
    // D=1 SB=2 BB=3 UTG=4 → postflop order 2,3,4,1
    t = play(t, [[4, call], [1, call], [2, call], [3, check]]);
    t = play(t, [[2, bet(80)]]); // full bet 80
    t = play(t, [[3, allin]]); // 130 total: +50, short
    t = play(t, [[4, allin]]); // 180 total: +50 more; cumulative +100 over 80 ≥ 80
    t = play(t, [[1, call]]);
    expect(t.hand!.toAct).toBe(2);
    expect(legalActions(t.hand!, 2)!.aggressive).toBe('raise');
  });

  it('no raise allowed when all opponents are all-in', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 2000 });
    t = play(t, [[1, allin], [2, fold]]);
    const l = legalActions(t.hand!, 3)!;
    expect(l.aggressive).toBe(null);
    expect(l.callIsAllIn).toBe(false);
  });
});

describe('uncalled bets and uncontested pots', () => {
  it('returns uncalled bet and awards uncontested pot automatically', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 1000 });
    t = play(t, [[1, raise(300)], [2, fold], [3, fold]]);
    expect(t.hand!.phase).toBe('complete');
    expect(t.hand!.result!.uncontested).toBe(true);
    expect(t.chips).toEqual({ 1: 1030, 2: 990, 3: 980 });
    expect(t.hand!.log.some((l) => l.type === 'refund' && l.amount === 280)).toBe(true);
  });

  it('refunds the excess over a short all-in call', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 300 });
    t = play(t, [[1, raise(800)], [2, fold], [3, call]]);
    // 3 called all-in 300 → 500 refunded to 1
    expect(t.hand!.phase).toBe('reveal');
    expect(t.hand!.bettingClosed).toBe(true);
    expect(seat(t, 1).committed).toBe(300);
    expect(seat(t, 1).stack).toBe(700);
    t = beginShowdown(t);
    expect(t.hand!.phase).toBe('showdown');
    expect(currentPots(t.hand!)).toEqual([{ amount: 610, eligible: [1, 3] }]);
  });

  it('refunds a folded small blind when a short big blind cannot cover it', () => {
    let t = begin({ 1: 1000, 2: 5 }, {});
    // heads-up: 1 = dealer/SB posts 10, 2 posts 5 all-in.
    t = play(t, [[1, fold]]);
    expect(t.hand!.phase).toBe('complete');
    expect(t.chips).toEqual({ 1: 995, 2: 10 });
  });
});

describe('side pots and showdown', () => {
  function threeWayAllIn(): TournamentState {
    // stacks: 1=100, 2=300, 3=600, 4=1000; D=1? firstDealer 4 → SB 1, BB 2, UTG 3
    let t = begin({ 1: 100, 2: 300, 3: 600, 4: 1000 }, { firstDealer: 4 });
    t = play(t, [[3, allin], [4, call], [1, allin], [2, allin]]);
    return t;
  }

  it('builds main and multiple side pots', () => {
    const t = threeWayAllIn();
    expect(t.hand!.phase).toBe('reveal');
    expect(t.hand!.bettingClosed).toBe(true);
    const pots = currentPots(t.hand!);
    expect(pots).toEqual([
      { amount: 400, eligible: [1, 2, 3, 4] },
      { amount: 600, eligible: [2, 3, 4] },
      { amount: 600, eligible: [3, 4] },
    ]);
    // 4's uncalled 400 was refunded
    expect(seat(t, 4).stack).toBe(400);
  });

  it('awards each pot to separately selected winners', () => {
    let t = beginShowdown(threeWayAllIn());
    t = awardPots(t, [[1], [2], [4]]);
    expect(t.chips).toEqual({ 1: 400, 2: 600, 3: 0, 4: 1000 });
    expect(totalChips(t)).toBe(2000);
    expect(t.eliminations).toEqual([{ seat: 3, place: 4, hand: 1 }]);
  });

  it('rejects ineligible winners', () => {
    const t = beginShowdown(threeWayAllIn());
    expect(code(() => awardPots(t, [[1], [1], [4]]))).toBe('INVALID_WINNERS');
    expect(code(() => awardPots(t, [[1], [2]]))).toBe('INVALID_WINNERS');
    expect(code(() => awardPots(t, [[1], [], [4]]))).toBe('INVALID_WINNERS');
  });

  it('includes folded contributions but excludes folded players', () => {
    let t = begin({ 1: 1000, 2: 200, 3: 1000 });
    // D1 SB2 BB3. 1 raises 100, 2 shoves 200, 3 calls 200, 1 calls → river with checks, then 3 folds to a bet
    t = play(t, [[1, raise(100)], [2, allin], [3, call], [1, call]]);
    t = play(t, [[3, bet(400)], [1, fold]]);
    // 3 bet uncalled → refunded; pot: main 600 eligible 2,3; nobody else can bet
    expect(t.hand!.phase).toBe('reveal');
    t = beginShowdown(t);
    expect(t.hand!.phase).toBe('showdown');
    expect(currentPots(t.hand!)).toEqual([{ amount: 600, eligible: [2, 3] }]);
  });

  it('splits ties and gives odd chips clockwise from the button', () => {
    expect(splitPot(101, [3, 5], 4)).toEqual({ 5: 51, 3: 50 });
    expect(splitPot(101, [3, 5], 1)).toEqual({ 3: 51, 5: 50 });
    expect(splitPot(100, [1, 2, 3], 2)).toEqual({ 3: 34, 1: 33, 2: 33 });
    expect(splitPot(2, [1, 2, 3], 3)).toEqual({ 1: 1, 2: 1, 3: 0 });
  });

  it('tied winners at showdown', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 1000 });
    t = play(t, [[1, call], [2, raise(55)], [3, call], [1, call]]);
    for (const _ of [0, 1, 2]) t = play(t, [[2, check], [3, check], [1, check]]);
    expect(t.hand!.phase).toBe('reveal');
    t = beginShowdown(t);
    expect(t.hand!.phase).toBe('showdown');
    const pots = currentPots(t.hand!);
    expect(pots).toEqual([{ amount: 165, eligible: [1, 2, 3] }]);
    t = awardPots(t, [[2, 3]]);
    // 165/2 = 82 r1; first clockwise from button(1) is 2
    expect(t.chips).toEqual({ 1: 945, 2: 1028, 3: 1027 });
  });

  it('display pots only split at all-in caps while betting is open', () => {
    let t = begin({ 1: 1000, 2: 1000, 3: 1000 });
    expect(displayPots(t.hand!.seats)).toEqual([{ amount: 30, eligible: [1, 2, 3] }]);
    t = begin({ 1: 1000, 2: 100, 3: 1000, 4: 1000 }, { firstDealer: 4 });
    // D4 SB1 BB2 UTG3
    t = play(t, [[3, raise(300)], [4, call], [1, call], [2, allin]]);
    expect(displayPots(t.hand!.seats)).toEqual([
      { amount: 400, eligible: [1, 2, 3, 4] },
      { amount: 600, eligible: [1, 3, 4] },
    ]);
  });

  it('computePots handles all-folded-but-one edge cases', () => {
    const pots = computePots([
      { seat: 1, stack: 0, bet: 0, committed: 50, folded: true, allIn: false, acted: true, actedLevel: 0 },
      { seat: 2, stack: 0, bet: 0, committed: 30, folded: false, allIn: true, acted: true, actedLevel: 0 },
      { seat: 3, stack: 0, bet: 0, committed: 80, folded: false, allIn: false, acted: true, actedLevel: 0 },
    ]);
    expect(pots).toEqual([
      { amount: 90, eligible: [2, 3] },
      { amount: 70, eligible: [3] },
    ]);
  });
});

describe('eliminations and tournament end', () => {
  it('eliminates busted players and ends with one winner', () => {
    let t = begin({ 1: 500, 2: 500 });
    t = play(t, [[1, allin], [2, call]]);
    t = beginShowdown(t);
    t = awardPots(t, [[2]]);
    expect(t.finished).toBe(true);
    expect(t.winner).toBe(2);
    expect(t.eliminations).toEqual([{ seat: 1, place: 2, hand: 1 }]);
    expect(code(() => startHand(t, 0))).toBe('TOURNAMENT_FINISHED');
  });

  it('busted players are skipped in later hands', () => {
    let t = begin({ 1: 100, 2: 1000, 3: 1000 });
    t = play(t, [[1, allin], [2, call], [3, call]]);
    for (let i = 0; i < 3; i++) t = play(t, [[2, check], [3, check]]);
    t = beginShowdown(t);
    expect(currentPots(t.hand!)).toEqual([{ amount: 300, eligible: [1, 2, 3] }]);
    t = awardPots(t, [[2]]);
    expect(t.chips[1]).toBe(0);
    t = startHand(t, 0);
    expect(t.hand!.seats.map((s) => s.seat)).toEqual([2, 3]);
    // last BB was 3 → BB moves to 2, 3 is dealer/SB
    expect(t.hand!.bbSeat).toBe(2);
    expect(t.hand!.dealer).toBe(3);
  });
});

describe('blind progression', () => {
  it('player-count schedule for six players', () => {
    let t = table({ 1: 2000, 2: 2000, 3: 2000, 4: 2000, 5: 2000, 6: 2000 }, { progression: 'players' });
    const seen: string[] = [];
    for (const out of [[], [6], [5], [4], [3]]) {
      for (const s of out) t.chips[s] = 0;
      t.levelIndex = levelFor(t, 0);
      const l = t.config.levels[t.levelIndex];
      seen.push(`${l.sb}/${l.bb}`);
    }
    expect(seen).toEqual(['10/20', '20/40', '30/60', '50/100', '100/200']);
  });

  it('time-based levels respect pauses and never decrease', () => {
    const config = defaultConfig({ progression: 'time', levelMinutes: 15 });
    let t = createTournament({ config, chips: { 1: 2000, 2: 2000 }, now: 0 });
    expect(levelFor(t, 14 * 60_000)).toBe(0);
    expect(levelFor(t, 15 * 60_000)).toBe(1);
    t = pauseClock(t, 10 * 60_000);
    expect(levelFor(t, 40 * 60_000)).toBe(0);
    t = resumeClock(t, 40 * 60_000);
    expect(levelFor(t, 45 * 60_000)).toBe(1);
    t.levelIndex = 3;
    expect(levelFor(t, 0)).toBe(3);
  });

  it('hybrid uses the highest level reached by either method', () => {
    const config = defaultConfig({ progression: 'hybrid', levelMinutes: 15 });
    const t = createTournament({ config, chips: { 1: 2000, 2: 2000, 3: 2000, 4: 0 }, now: 0 });
    t.startPlayerCount = 4; // seat 4 eliminated
    expect(levelFor(t, 0)).toBe(1);
    expect(levelFor(t, 31 * 60_000)).toBe(2);
  });

  it('blind changes apply only at the next hand', () => {
    let t = begin({ 1: 2000, 2: 2000 }, { progression: 'time' });
    expect(t.hand!.blinds).toEqual({ sb: 10, bb: 20 });
    t = play(t, [[1, fold]]);
    t = startHand(t, 16 * 60_000);
    expect(t.hand!.blinds).toEqual({ sb: 20, bb: 40 });
  });
});

describe('admin chip reset', () => {
  it('only between hands and needs two players with chips', () => {
    const t = begin({ 1: 1000, 2: 1000 });
    expect(code(() => resetChips(t, { 1: 500 }))).toBe('HAND_IN_PROGRESS');
    const done = play(t, [[1, fold]]);
    expect(code(() => resetChips(done, { 1: 0 }))).toBe('NOT_ENOUGH_PLAYERS');
    const r = resetChips(done, { 1: 3000, 2: 10 });
    expect(r.chips).toEqual({ 1: 3000, 2: 10 });
    expect(r.hand).toBe(null);
  });
});

describe('chip conservation fuzz', () => {
  it('random legal play never creates or destroys chips', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let game = 0; game < 40; game++) {
      const n = 2 + Math.floor(rnd() * 8);
      const chips: Record<number, number> = {};
      for (let s = 1; s <= n; s++) chips[s] = 100 + Math.floor(rnd() * 3000);
      let t = createTournament({ config: defaultConfig({ progression: 'players' }), chips, now: 0 });
      const total = totalChips(t);
      let hands = 0;
      while (!t.finished && hands < 200) {
        t = startHand(t, 0);
        hands++;
        while (t.hand!.phase !== 'complete') {
          const h = t.hand!;
          if (h.phase === 'betting') {
            const l = legalActions(h, h.toAct!)!;
            const r = rnd();
            let a;
            if (r < 0.15) a = fold;
            else if (r < 0.55) a = l.canCheck ? check : call;
            else if (r < 0.85 && l.aggressive) {
              const to = l.minTo + Math.floor(rnd() * (l.maxTo - l.minTo + 1));
              a = { type: l.aggressive, amount: to } as const;
            } else if (l.canAllIn) a = allin;
            else a = l.canCheck ? check : call;
            t = applyAction(t, h.toAct!, a);
          } else if (h.phase === 'reveal') t = beginShowdown(t);
          else if (h.phase === 'showdown') {
            const pots = currentPots(h);
            t = awardPots(
              t,
              pots.map((p) => (rnd() < 0.2 && p.eligible.length > 1 ? p.eligible.slice(0, 2) : [p.eligible[Math.floor(rnd() * p.eligible.length)]])),
            );
          }
          expect(totalChips(t)).toBe(total);
        }
      }
      expect(Object.values(t.chips).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});
