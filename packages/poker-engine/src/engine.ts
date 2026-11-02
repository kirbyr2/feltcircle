import type {
  HandSeat,
  HandState,
  LegalActions,
  PlayerAction,
  PotResult,
  Street,
  TournamentConfig,
  TournamentState,
} from './types.js';
import { EngineError } from './errors.js';
import { computePositions, clockwiseFrom } from './seats.js';
import { computePots, potTotal, splitPot } from './pots.js';
import { levelFor, validateConfig } from './blinds.js';

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];

const clone = <T>(v: T): T => structuredClone(v);

function isChipAmount(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= 0;
}

// ---------------------------------------------------------------------------
// Tournament lifecycle
// ---------------------------------------------------------------------------

export interface CreateTournamentOptions {
  config: TournamentConfig;
  /** Seat number → starting chips. Seats with 0 chips are recorded but never dealt in. */
  chips: Record<number, number>;
  now: number;
  /** Dealer for the first hand (default: lowest seat with chips). */
  firstDealer?: number;
}

export function createTournament(opts: CreateTournamentOptions): TournamentState {
  const bad = validateConfig(opts.config);
  if (bad) throw new EngineError('INVALID_CONFIG', bad);
  const seats = Object.keys(opts.chips)
    .map(Number)
    .sort((a, b) => a - b);
  const chips: Record<number, number> = {};
  for (const s of seats) {
    if (!Number.isSafeInteger(s) || s < 1) throw new EngineError('INVALID_CONFIG', 'seat');
    if (!isChipAmount(opts.chips[s])) throw new EngineError('INVALID_CONFIG', 'chips');
    chips[s] = opts.chips[s];
  }
  const live = seats.filter((s) => chips[s] > 0);
  if (live.length < 2) throw new EngineError('NOT_ENOUGH_PLAYERS');
  return {
    config: clone(opts.config),
    seats,
    chips,
    startPlayerCount: live.length,
    levelIndex: 0,
    startedAt: opts.now,
    pausedMs: 0,
    pausedAt: null,
    handCount: 0,
    firstDealer: opts.firstDealer ?? live[0],
    lastBbSeat: null,
    eliminations: [],
    hand: null,
    finished: false,
    winner: null,
  };
}

export function liveSeats(t: TournamentState): number[] {
  return t.seats.filter((s) => (t.chips[s] ?? 0) > 0);
}

export function pauseClock(t: TournamentState, now: number): TournamentState {
  if (t.pausedAt !== null) return t;
  return { ...t, pausedAt: now };
}

export function resumeClock(t: TournamentState, now: number): TournamentState {
  if (t.pausedAt === null) return t;
  return { ...t, pausedMs: t.pausedMs + Math.max(0, now - t.pausedAt), pausedAt: null };
}

/** Replace the blind ladder for future hands. The current level index is kept (clamped). */
export function setBlindConfig(t: TournamentState, config: TournamentConfig): TournamentState {
  const bad = validateConfig(config);
  if (bad) throw new EngineError('INVALID_CONFIG', bad);
  const next = clone(t);
  next.config = clone(config);
  next.levelIndex = Math.min(next.levelIndex, config.levels.length - 1);
  return next;
}

/**
 * Administrative chip reset between hands (e.g. chip import). Any hand state is
 * discarded; seats with zero chips are treated as eliminated.
 */
export function resetChips(t: TournamentState, chips: Record<number, number>): TournamentState {
  if (t.hand && t.hand.phase !== 'complete') throw new EngineError('HAND_IN_PROGRESS');
  const next = clone(t);
  for (const [k, v] of Object.entries(chips)) {
    const seat = Number(k);
    if (!next.seats.includes(seat)) throw new EngineError('INVALID_CONFIG', 'seat');
    if (!isChipAmount(v)) throw new EngineError('INVALID_CONFIG', 'chips');
    next.chips[seat] = v;
  }
  const live = liveSeats(next);
  if (live.length < 2) throw new EngineError('NOT_ENOUGH_PLAYERS');
  next.hand = null;
  next.eliminations = next.eliminations.filter((e) => (next.chips[e.seat] ?? 0) === 0);
  next.finished = false;
  next.winner = null;
  if (next.lastBbSeat !== null && !next.seats.includes(next.lastBbSeat)) next.lastBbSeat = null;
  return next;
}

/**
 * Give chips to a seat that is not currently playing (late joiner, or a busted
 * player re-entering). Allowed at any time: a hand in progress is not affected
 * and the player is dealt in from the next hand. FeltCircle does not enforce a
 * fixed chip supply, so this adds chips to the table.
 */
export function seatPlayer(t: TournamentState, seat: number, chips: number): TournamentState {
  if (!Number.isSafeInteger(seat) || seat < 1) throw new EngineError('INVALID_SEAT');
  if (!isChipAmount(chips) || chips <= 0) throw new EngineError('INVALID_AMOUNT');
  if ((t.chips[seat] ?? 0) > 0) throw new EngineError('INVALID_SEAT');
  if (t.hand && t.hand.phase !== 'complete' && t.hand.seats.some((s) => s.seat === seat)) throw new EngineError('INVALID_SEAT');
  const next = clone(t);
  if (!next.seats.includes(seat)) {
    next.seats.push(seat);
    next.seats.sort((a, b) => a - b);
  }
  next.chips[seat] = chips;
  next.startPlayerCount += 1;
  next.eliminations = next.eliminations.filter((e) => e.seat !== seat);
  refreshFinished(next);
  return next;
}

/** Administrative balance correction for one seat, between hands only. */
export function setSeatChips(t: TournamentState, seat: number, chips: number): TournamentState {
  if (t.hand && t.hand.phase !== 'complete') throw new EngineError('HAND_IN_PROGRESS');
  if (!t.seats.includes(seat)) throw new EngineError('INVALID_SEAT');
  if (!isChipAmount(chips)) throw new EngineError('INVALID_AMOUNT');
  const next = clone(t);
  next.chips[seat] = chips;
  if (chips > 0) next.eliminations = next.eliminations.filter((e) => e.seat !== seat);
  refreshFinished(next);
  return next;
}

function refreshFinished(t: TournamentState) {
  const live = liveSeats(t);
  t.finished = live.length <= 1;
  t.winner = t.finished ? (live[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Hand lifecycle
// ---------------------------------------------------------------------------

export function startHand(t0: TournamentState, now: number): TournamentState {
  if (t0.finished) throw new EngineError('TOURNAMENT_FINISHED');
  if (t0.hand && t0.hand.phase !== 'complete') throw new EngineError('HAND_IN_PROGRESS');
  const live = liveSeats(t0);
  if (live.length < 2) throw new EngineError('NOT_ENOUGH_PLAYERS');
  const t = clone(t0);
  t.levelIndex = levelFor(t, now);
  const blinds = { ...t.config.levels[t.levelIndex] };
  const pos = computePositions(live, t.lastBbSeat, t.firstDealer);
  const seats: HandSeat[] = live.map((seat) => ({
    seat,
    stack: t.chips[seat],
    bet: 0,
    committed: 0,
    folded: false,
    allIn: false,
    acted: false,
    actedLevel: 0,
  }));
  const startStacks: Record<number, number> = {};
  for (const s of seats) startStacks[s.seat] = s.stack;
  t.handCount += 1;
  const hand: HandState = {
    number: t.handCount,
    dealer: pos.dealer,
    sbSeat: pos.sbSeat,
    bbSeat: pos.bbSeat,
    blinds,
    street: 'preflop',
    phase: 'betting',
    seats,
    toAct: null,
    currentBet: 0,
    minRaise: blinds.bb,
    bettingClosed: false,
    startStacks,
    log: [],
    result: null,
  };
  post(hand, pos.sbSeat, blinds.sb, 'sb');
  post(hand, pos.bbSeat, blinds.bb, 'bb');
  // Players must match a full big blind even if the big blind is all-in for less.
  hand.currentBet = Math.max(blinds.bb, ...seats.map((s) => s.bet));
  hand.minRaise = blinds.bb;
  t.hand = hand;
  afterStateChange(t, pos.bbSeat);
  return t;
}

function post(hand: HandState, seat: number, amount: number, type: 'sb' | 'bb') {
  const p = seatOf(hand, seat);
  const pay = Math.min(p.stack, amount);
  p.stack -= pay;
  p.bet += pay;
  p.committed += pay;
  if (p.stack === 0) p.allIn = true;
  hand.log.push({ seat, street: 'preflop', type, amount: pay, allIn: p.allIn || undefined });
}

function seatOf(hand: HandState, seat: number): HandSeat {
  const p = hand.seats.find((s) => s.seat === seat);
  if (!p) throw new EngineError('NOT_YOUR_TURN');
  return p;
}

function needsAction(hand: HandState, p: HandSeat): boolean {
  return !p.folded && !p.allIn && (!p.acted || p.bet < hand.currentBet);
}

function roundComplete(hand: HandState): boolean {
  const canAct = hand.seats.filter((p) => !p.folded && !p.allIn);
  if (canAct.length === 0) return true;
  if (canAct.length === 1 && canAct[0].bet >= hand.currentBet) return true;
  return canAct.every((p) => p.acted && p.bet === hand.currentBet);
}

/**
 * After any change: finish the hand if only one player remains, close the
 * betting round if complete, otherwise move `toAct` clockwise from `fromSeat`.
 */
function afterStateChange(t: TournamentState, fromSeat: number) {
  const hand = t.hand!;
  const notFolded = hand.seats.filter((p) => !p.folded);
  if (notFolded.length === 1) {
    refundUncalled(hand);
    finishUncontested(t, notFolded[0].seat);
    return;
  }
  if (roundComplete(hand)) {
    endBettingRound(t);
    return;
  }
  const order = clockwiseFrom(
    hand.seats.map((s) => s.seat),
    fromSeat,
  );
  const next = order.find((s) => needsAction(hand, seatOf(hand, s)));
  if (next === undefined) {
    endBettingRound(t);
    return;
  }
  hand.toAct = next;
}

function refundUncalled(hand: HandState) {
  const sorted = [...hand.seats].sort((a, b) => b.bet - a.bet);
  const top = sorted[0];
  const second = sorted[1]?.bet ?? 0;
  if (top && top.bet > second) {
    const diff = top.bet - second;
    top.bet -= diff;
    top.committed -= diff;
    top.stack += diff;
    if (top.stack > 0) top.allIn = false;
    hand.log.push({ seat: top.seat, street: hand.street, type: 'refund', amount: diff });
  }
}

function endBettingRound(t: TournamentState) {
  const hand = t.hand!;
  refundUncalled(hand);
  for (const p of hand.seats) {
    p.bet = 0;
    p.acted = false;
    p.actedLevel = 0;
  }
  hand.currentBet = 0;
  hand.minRaise = hand.blinds.bb;
  hand.toAct = null;
  const canAct = hand.seats.filter((p) => !p.folded && !p.allIn);
  hand.bettingClosed = canAct.length < 2;
  if (hand.bettingClosed || hand.street === 'river') {
    // No further betting: finish the board (if needed) and reveal; the host confirms the showdown.
    hand.phase = 'reveal';
    return;
  }
  // Next street right away: its cards are dealt physically before the first player acts.
  hand.street = STREETS[STREETS.indexOf(hand.street) + 1];
  hand.phase = 'betting';
  afterStateChange(t, hand.dealer);
}

function finishUncontested(t: TournamentState, winner: number) {
  const hand = t.hand!;
  const amount = potTotal(hand.seats);
  const eligible = [winner];
  const pots: PotResult[] = [{ amount, eligible, winners: [winner], payouts: { [winner]: amount } }];
  completeHand(t, pots, true);
}

function completeHand(t: TournamentState, pots: PotResult[], uncontested: boolean) {
  const hand = t.hand!;
  const net: Record<number, number> = {};
  for (const p of hand.seats) net[p.seat] = -p.committed;
  for (const pot of pots) {
    for (const [seat, amt] of Object.entries(pot.payouts)) {
      const p = seatOf(hand, Number(seat));
      p.stack += amt;
      net[p.seat] += amt;
      hand.log.push({ seat: p.seat, street: hand.street, type: 'win', amount: amt });
    }
  }
  for (const p of hand.seats) {
    p.bet = 0;
    p.committed = 0;
  }
  hand.result = { uncontested, pots, net };
  hand.phase = 'complete';
  hand.toAct = null;
  hand.currentBet = 0;
  // Write back confirmed balances.
  for (const p of hand.seats) t.chips[p.seat] = p.stack;
  t.lastBbSeat = hand.bbSeat;
  // Eliminations: players busting in the same hand are ranked by starting stack.
  const busted = hand.seats
    .filter((p) => p.stack === 0)
    .sort((a, b) => hand.startStacks[a.seat] - hand.startStacks[b.seat]);
  const remaining = liveSeats(t).length;
  const placeBase = remaining + busted.length;
  busted.forEach((p, i) => {
    t.eliminations.push({ seat: p.seat, place: placeBase - i, hand: hand.number });
  });
  if (remaining <= 1) {
    t.finished = true;
    t.winner = liveSeats(t)[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------

export function legalActions(hand: HandState, seat: number): LegalActions | null {
  if (hand.phase !== 'betting' || hand.toAct !== seat) return null;
  const p = seatOf(hand, seat);
  const canCheck = p.bet >= hand.currentBet;
  const toCall = canCheck ? 0 : Math.min(hand.currentBet - p.bet, p.stack);
  const maxTo = p.bet + p.stack;
  const othersCanRespond = hand.seats.some((o) => o.seat !== seat && !o.folded && !o.allIn);
  const reopened = !p.acted || hand.currentBet - p.actedLevel >= hand.minRaise;
  const canRaise = othersCanRespond && reopened && maxTo > hand.currentBet;
  const fullMinTo = hand.currentBet === 0 ? hand.blinds.bb : hand.currentBet + hand.minRaise;
  const minTo = Math.min(fullMinTo, maxTo);
  return {
    seat,
    canFold: true,
    canCheck,
    callAmount: toCall,
    callIsAllIn: !canCheck && toCall === p.stack,
    aggressive: canRaise ? (hand.currentBet === 0 ? 'bet' : 'raise') : null,
    minTo: canRaise ? minTo : 0,
    fullMinTo,
    maxTo,
    canAllIn: p.stack > 0 && (canRaise || maxTo <= hand.currentBet),
    currentBet: p.bet,
    tableBet: hand.currentBet,
    potTotal: potTotal(hand.seats),
  };
}

export interface ApplyOptions {
  /** Marks the action as automatic (pre-action / auto-fold) in the hand log. */
  auto?: boolean;
}

export function applyAction(t0: TournamentState, seat: number, action: PlayerAction, opts: ApplyOptions = {}): TournamentState {
  const h0 = t0.hand;
  if (!h0) throw new EngineError('NO_HAND');
  if (h0.phase !== 'betting') throw new EngineError('WRONG_PHASE');
  if (h0.toAct !== seat) throw new EngineError('NOT_YOUR_TURN');
  const legal = legalActions(h0, seat)!;
  const t = clone(t0);
  const hand = t.hand!;
  const p = seatOf(hand, seat);
  const auto = opts.auto || undefined;
  const street = hand.street;

  const pay = (amount: number) => {
    p.stack -= amount;
    p.bet += amount;
    p.committed += amount;
    if (p.stack === 0) p.allIn = true;
  };

  const raiseTo = (to: number) => {
    const raiseSize = to - hand.currentBet;
    if (raiseSize >= hand.minRaise) hand.minRaise = raiseSize; // full raise
    pay(to - p.bet);
    hand.currentBet = Math.max(hand.currentBet, to);
    p.acted = true;
    p.actedLevel = hand.currentBet;
  };

  switch (action.type) {
    case 'fold':
      p.folded = true;
      p.acted = true;
      hand.log.push({ seat, street, type: 'fold', auto });
      break;
    case 'check':
      if (!legal.canCheck) throw new EngineError('ILLEGAL_ACTION');
      p.acted = true;
      p.actedLevel = hand.currentBet;
      hand.log.push({ seat, street, type: 'check', auto });
      break;
    case 'call':
      if (legal.canCheck) throw new EngineError('ILLEGAL_ACTION');
      pay(legal.callAmount);
      p.acted = true;
      p.actedLevel = hand.currentBet;
      hand.log.push({ seat, street, type: 'call', amount: legal.callAmount, allIn: p.allIn || undefined, auto });
      break;
    case 'bet':
    case 'raise': {
      if (legal.aggressive !== action.type) throw new EngineError('ILLEGAL_ACTION');
      const to = action.amount;
      if (!Number.isSafeInteger(to)) throw new EngineError('INVALID_AMOUNT');
      if (to > legal.maxTo) throw new EngineError('BET_TOO_LARGE');
      if (to < legal.minTo) throw new EngineError('BET_TOO_SMALL');
      raiseTo(to);
      hand.log.push({ seat, street, type: action.type, amount: to, allIn: p.allIn || undefined, auto });
      break;
    }
    case 'allin': {
      if (!legal.canAllIn) throw new EngineError('ILLEGAL_ACTION');
      if (legal.maxTo <= hand.currentBet) {
        const amount = p.stack;
        pay(amount);
        p.acted = true;
        p.actedLevel = hand.currentBet;
        hand.log.push({ seat, street, type: 'call', amount, allIn: true, auto });
      } else {
        raiseTo(legal.maxTo);
        hand.log.push({ seat, street, type: 'allin', amount: legal.maxTo, allIn: true, auto });
      }
      break;
    }
    default:
      throw new EngineError('ILLEGAL_ACTION');
  }
  afterStateChange(t, seat);
  return t;
}

/**
 * Host confirms that every card is dealt and the hands are revealed: players
 * may now declare and the host may settle the pots. Only possible once no
 * further betting can happen (`reveal`).
 */
export function beginShowdown(t0: TournamentState): TournamentState {
  const h0 = t0.hand;
  if (!h0) throw new EngineError('NO_HAND');
  if (h0.phase !== 'reveal') throw new EngineError('WRONG_PHASE');
  const t = clone(t0);
  t.hand!.phase = 'showdown';
  t.hand!.street = 'river';
  return t;
}

/**
 * Hands stored by an earlier version may wait in the removed
 * `street-complete` phase: continue them under the current rules (start the
 * next street, or wait for the showdown confirmation).
 */
export function normalizeTournament(t0: TournamentState): TournamentState {
  const h0 = t0.hand;
  if (!h0 || (h0.phase as string) !== 'street-complete') return t0;
  const t = clone(t0);
  const hand = t.hand!;
  if (hand.bettingClosed) {
    hand.phase = 'reveal';
    return t;
  }
  hand.street = STREETS[STREETS.indexOf(hand.street) + 1];
  hand.phase = 'betting';
  hand.currentBet = 0;
  hand.minRaise = hand.blinds.bb;
  afterStateChange(t, hand.dealer);
  return t;
}

/**
 * Cards still to be dealt before the current street's first decision, or
 * null. Shown as "Deal the flop, then …" until somebody acts on the street by
 * hand (automatic pre-actions may run before the cards are on the table).
 */
export function streetToDeal(hand: HandState): Exclude<Street, 'preflop'> | null {
  if (hand.phase !== 'betting' || hand.street === 'preflop') return null;
  const acted = hand.log.some((e) => e.street === hand.street && !e.auto && e.type !== 'refund' && e.type !== 'win');
  return acted ? null : hand.street;
}

/**
 * Fold at showdown: a player gives up the right to win any pot of this hand
 * (committed chips stay in the pots). Not allowed when they are the only
 * remaining contender for a pot (somebody must be able to win it). When every
 * pot is left with a single contender, the hand is settled automatically.
 */
export function muck(t0: TournamentState, seat: number, opts: ApplyOptions = {}): TournamentState {
  const h0 = t0.hand;
  if (!h0) throw new EngineError('NO_HAND');
  if (h0.phase !== 'showdown') throw new EngineError('WRONG_PHASE');
  const p0 = h0.seats.find((s) => s.seat === seat);
  if (!p0 || p0.folded) throw new EngineError('ILLEGAL_ACTION');
  for (const pot of computePots(h0.seats)) {
    if (pot.eligible.includes(seat) && pot.eligible.length < 2) throw new EngineError('CANNOT_MUCK');
  }
  const t = clone(t0);
  const hand = t.hand!;
  const p = seatOf(hand, seat);
  p.folded = true;
  p.mucked = true;
  hand.log.push({ seat, street: hand.street, type: 'muck', auto: opts.auto || undefined });
  const pots = computePots(hand.seats);
  if (pots.every((pot) => pot.eligible.length === 1)) {
    completeHand(
      t,
      pots.map((pot) => ({ ...pot, winners: [...pot.eligible], payouts: { [pot.eligible[0]]: pot.amount } })),
      true,
    );
  }
  return t;
}

/** Pots for display or showdown, computed from total contributions. */
export function currentPots(hand: HandState) {
  return computePots(hand.seats);
}

/**
 * Host selects winners for each pot (same order as `currentPots`). Ties are
 * expressed by multiple winners. The engine computes all payouts.
 */
export function awardPots(t0: TournamentState, winners: number[][]): TournamentState {
  const h0 = t0.hand;
  if (!h0) throw new EngineError('NO_HAND');
  if (h0.phase !== 'showdown') throw new EngineError('WRONG_PHASE');
  const pots = computePots(h0.seats);
  if (!Array.isArray(winners) || winners.length !== pots.length) throw new EngineError('INVALID_WINNERS');
  const results: PotResult[] = pots.map((pot, i) => {
    const w = winners[i];
    if (!Array.isArray(w) || w.length === 0) throw new EngineError('INVALID_WINNERS');
    const unique = [...new Set(w)];
    if (unique.length !== w.length || !unique.every((s) => pot.eligible.includes(s))) {
      throw new EngineError('INVALID_WINNERS');
    }
    return { ...pot, winners: unique.sort((a, b) => a - b), payouts: splitPot(pot.amount, unique, h0.dealer) };
  });
  const t = clone(t0);
  completeHand(t, results, false);
  return t;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** Total chips in play (balances + stacks + committed). Constant except for admin resets. */
export function totalChips(t: TournamentState): number {
  if (t.hand && t.hand.phase !== 'complete') {
    const inHand = new Set(t.hand.seats.map((s) => s.seat));
    const outside = t.seats.filter((s) => !inHand.has(s)).reduce((a, s) => a + (t.chips[s] ?? 0), 0);
    return outside + t.hand.seats.reduce((a, s) => a + s.stack + s.committed, 0);
  }
  return t.seats.reduce((a, s) => a + (t.chips[s] ?? 0), 0);
}

/** Live balances: stacks during a hand, confirmed chips otherwise. */
export function displayStacks(t: TournamentState): Record<number, number> {
  const out: Record<number, number> = { ...t.chips };
  if (t.hand && t.hand.phase !== 'complete') for (const s of t.hand.seats) out[s.seat] = s.stack;
  return out;
}

/** Automatic action a player can pre-select while waiting for their turn (online only). */
export type PreActionChoice = 'fold' | 'checkfold' | 'check' | 'callany';

/**
 * Chips `seat` would have to put in if the turn reached them right now, or
 * null when the player cannot pre-select anything (not in the hand, folded,
 * all-in, no betting left). A new street starts without a bet, so nothing is
 * owed until somebody bets. This is the amount actually owed, not whether
 * somebody raised: a big blind facing only calls owes nothing.
 */
export function owedForPreAction(hand: HandState, seat: number): number | null {
  if (hand.phase !== 'betting') return null;
  const p = hand.seats.find((s) => s.seat === seat);
  if (!p || p.folded || p.allIn) return null;
  return Math.max(0, hand.currentBet - p.bet);
}

/**
 * Pre-actions on offer for `seat`, in display order. When checking is legal
 * (nothing owed): Check/Fold, Check, Call Any — no standalone Fold. When chips
 * are owed: Fold, Check/Fold, Call Any (Check is not offered, it could only be
 * cancelled).
 */
export function preActionChoices(hand: HandState, seat: number): PreActionChoice[] {
  const owed = owedForPreAction(hand, seat);
  if (owed === null) return [];
  return owed === 0 ? ['checkfold', 'check', 'callany'] : ['fold', 'checkfold', 'callany'];
}

/**
 * What a selected pre-action does when the turn arrives: an action to play,
 * or 'cancel' (Check while a call is required — never folds or calls).
 * Call Any calls the amount owed, capped at the remaining stack (all-in).
 */
export function resolvePreAction(choice: PreActionChoice, legal: LegalActions): PlayerAction | 'cancel' {
  switch (choice) {
    case 'fold':
      return { type: 'fold' };
    case 'checkfold':
      return legal.canCheck ? { type: 'check' } : { type: 'fold' };
    case 'check':
      return legal.canCheck ? { type: 'check' } : 'cancel';
    case 'callany':
      return legal.canCheck ? { type: 'check' } : { type: 'call' };
  }
}
