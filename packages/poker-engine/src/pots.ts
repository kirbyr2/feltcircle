import type { HandSeat, Pot } from './types.js';
import { clockwiseFrom } from './seats.js';
import { EngineError } from './errors.js';

/**
 * Build main pot and side pots from total contributions.
 * Folded players' chips stay in the pots but they are never eligible.
 * Pots with identical eligibility are merged.
 */
export function computePots(seats: readonly HandSeat[]): Pot[] {
  const live = seats.filter((s) => !s.folded);
  const levels = [...new Set(live.map((s) => s.committed).filter((c) => c > 0))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const s of seats) amount += Math.min(s.committed, level) - Math.min(s.committed, prev);
    const eligible = live.filter((s) => s.committed >= level).map((s) => s.seat);
    if (amount > 0) {
      const last = pots[pots.length - 1];
      if (last && sameSet(last.eligible, eligible)) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    prev = level;
  }
  // Dead money above the highest live contribution (cannot normally happen after
  // uncalled-bet refunds) is added to the last pot so chips are always conserved.
  const total = seats.reduce((a, s) => a + s.committed, 0);
  const counted = pots.reduce((a, p) => a + p.amount, 0);
  if (total > counted) {
    if (pots.length === 0) pots.push({ amount: 0, eligible: live.map((s) => s.seat) });
    pots[pots.length - 1].amount += total - counted;
  }
  return pots;
}

/**
 * Pots for display while betting is still open: only all-in players cap a pot,
 * because everyone else can still match the bet. At showdown this equals `computePots`.
 */
export function displayPots(seats: readonly HandSeat[]): Pot[] {
  const live = seats.filter((s) => !s.folded);
  const caps = [...new Set(live.filter((s) => s.allIn).map((s) => s.committed).filter((c) => c > 0))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  const push = (amount: number, eligible: number[]) => {
    const last = pots[pots.length - 1];
    if (last && sameSet(last.eligible, eligible)) last.amount += amount;
    else if (amount > 0) pots.push({ amount, eligible });
  };
  for (const cap of caps) {
    let amount = 0;
    for (const s of seats) amount += Math.min(s.committed, cap) - Math.min(s.committed, prev);
    push(amount, live.filter((s) => s.committed >= cap || !s.allIn).map((s) => s.seat));
    prev = cap;
  }
  const total = seats.reduce((a, s) => a + s.committed, 0);
  const rest = total - pots.reduce((a, p) => a + p.amount, 0);
  const restEligible = live.filter((s) => !s.allIn || s.committed > prev).map((s) => s.seat);
  if (rest > 0) {
    if (restEligible.length) push(rest, restEligible);
    else if (pots.length) pots[pots.length - 1].amount += rest;
  }
  return pots;
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Split a pot between winners. Odd chips go one at a time to the winners
 * closest clockwise from the dealer button (standard rule).
 */
export function splitPot(amount: number, winners: readonly number[], dealer: number): Record<number, number> {
  if (winners.length === 0) throw new EngineError('INVALID_WINNERS');
  const share = Math.floor(amount / winners.length);
  let remainder = amount - share * winners.length;
  const payouts: Record<number, number> = {};
  for (const w of winners) payouts[w] = share;
  for (const s of clockwiseFrom(winners, dealer)) {
    if (remainder <= 0) break;
    payouts[s] += 1;
    remainder--;
  }
  return payouts;
}

export function potTotal(seats: readonly HandSeat[]): number {
  return seats.reduce((a, s) => a + s.committed, 0);
}
