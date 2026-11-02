import { applyAction, createTournament, defaultConfig, startHand, totalChips, type PlayerAction, type TournamentState } from '../src/index.js';

export function table(chips: Record<number, number>, opts: { sb?: number; bb?: number; firstDealer?: number; progression?: 'time' | 'players' | 'hybrid' | 'fixed' } = {}) {
  const config = defaultConfig({ sb: opts.sb ?? 10, bb: opts.bb ?? 20, progression: opts.progression ?? 'players' });
  return createTournament({ config, chips, now: 0, firstDealer: opts.firstDealer });
}

export function begin(chips: Record<number, number>, opts: Parameters<typeof table>[1] = {}) {
  return startHand(table(chips, opts), 0);
}

/** Apply a sequence of [seat, action] pairs, asserting chip conservation after each step. */
export function play(t: TournamentState, steps: Array<[number, PlayerAction]>): TournamentState {
  const total = totalChips(t);
  for (const [seat, action] of steps) {
    t = applyAction(t, seat, action);
    if (totalChips(t) !== total) throw new Error(`chip conservation violated after ${seat} ${action.type}`);
  }
  return t;
}

export const fold = { type: 'fold' } as const;
export const check = { type: 'check' } as const;
export const call = { type: 'call' } as const;
export const allin = { type: 'allin' } as const;
export const bet = (amount: number) => ({ type: 'bet', amount }) as const;
export const raise = (amount: number) => ({ type: 'raise', amount }) as const;

export function seat(t: TournamentState, s: number) {
  return t.hand!.seats.find((x) => x.seat === s)!;
}
