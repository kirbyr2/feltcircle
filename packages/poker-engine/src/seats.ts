/** Seat helpers. Seats are physical positions numbered clockwise; empty seats are skipped. */

/** First seat in `live` strictly clockwise after `from` (wrapping). `from` need not be live. */
export function nextSeat(live: readonly number[], from: number): number {
  if (live.length === 0) throw new Error('no live seats');
  const sorted = [...live].sort((a, b) => a - b);
  return sorted.find((s) => s > from) ?? sorted[0];
}

/** First seat in `live` strictly counter-clockwise before `from` (wrapping). */
export function prevSeat(live: readonly number[], from: number): number {
  if (live.length === 0) throw new Error('no live seats');
  const sorted = [...live].sort((a, b) => a - b);
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i] < from) return sorted[i];
  return sorted[sorted.length - 1];
}

/** Seats ordered clockwise starting strictly after `from`. */
export function clockwiseFrom(seats: readonly number[], from: number): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  const after = sorted.filter((s) => s > from);
  const before = sorted.filter((s) => s <= from);
  return [...after, ...before];
}

export interface Positions {
  dealer: number;
  sbSeat: number;
  bbSeat: number;
}

/**
 * Determine dealer / blinds for the next hand using a "moving big blind":
 * the big blind always advances to the next live player clockwise, so nobody
 * skips or repeats the big blind when players are eliminated. The small blind
 * and button sit on the live players immediately counter-clockwise of it.
 * Heads-up: the dealer posts the small blind and the other player the big blind,
 * and the big blind alternates every hand (also across the transition to heads-up).
 */
export function computePositions(live: readonly number[], lastBbSeat: number | null, firstDealer: number): Positions {
  if (live.length < 2) throw new Error('need two live seats');
  if (lastBbSeat === null) {
    const dealer = live.includes(firstDealer) ? firstDealer : nextSeat(live, firstDealer);
    if (live.length === 2) return { dealer, sbSeat: dealer, bbSeat: nextSeat(live, dealer) };
    const sbSeat = nextSeat(live, dealer);
    return { dealer, sbSeat, bbSeat: nextSeat(live, sbSeat) };
  }
  const bbSeat = nextSeat(live, lastBbSeat);
  const sbSeat = prevSeat(live, bbSeat);
  if (live.length === 2) return { dealer: sbSeat, sbSeat, bbSeat };
  return { dealer: prevSeat(live, sbSeat), sbSeat, bbSeat };
}
