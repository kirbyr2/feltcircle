/** Betting streets. Cards are physical; the engine only tracks betting. */
export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/**
 * Hand phases (cards are physical; nobody confirms dealing between streets):
 * - betting:   a player must act (`toAct`). When a round ends before the river
 *              and two or more players can still bet, the next street starts at
 *              once; players deal its cards before the first player acts.
 * - reveal:    no more betting: river betting finished, or betting is closed
 *              (fewer than two players can bet) and the board must be run out.
 *              Waiting for the host to confirm that all cards are dealt and
 *              hands revealed.
 * - showdown:  players declare Win / Tie / Fold; the host settles each pot
 *              (or one sole Win claimant takes an undisputed single pot).
 * - complete:  chips distributed; waiting for the next hand.
 */
export type HandPhase = 'betting' | 'reveal' | 'showdown' | 'complete';

/** `fixed`: blinds never change automatically (the host may still change them between hands). */
export type BlindProgression = 'time' | 'players' | 'hybrid' | 'fixed';

export interface BlindLevel {
  sb: number;
  bb: number;
}

export interface TournamentConfig {
  startingChips: number;
  /** Blind ladder. Level 0 is the starting level. Levels never decrease. */
  levels: BlindLevel[];
  progression: BlindProgression;
  /** Minutes per level for time-based progression. */
  levelMinutes: number;
  /** Eliminations required per blind level for player-based progression. */
  playersPerLevel: number;
}

export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  /** Opening bet. `amount` is the total bet for this street. */
  | { type: 'bet'; amount: number }
  /** Raise. `amount` is the total "raise to" for this street. */
  | { type: 'raise'; amount: number }
  | { type: 'allin' };

export type ActionType = PlayerAction['type'];

export interface HandSeat {
  seat: number;
  /** Chips behind (not yet committed). */
  stack: number;
  /** Chips committed on the current street. */
  bet: number;
  /** Chips committed during the whole hand (including current street). */
  committed: number;
  folded: boolean;
  allIn: boolean;
  /** Whether the player has voluntarily acted since the street started. Blind posts do not count. */
  acted: boolean;
  /** The current bet level right after this player's last voluntary action (for action-reopening rules). */
  actedLevel: number;
  /** Folded at showdown (gave up the right to win; chips stay in the pot). Also marked as folded. */
  mucked?: boolean;
}

export interface Pot {
  amount: number;
  /** Seats eligible to win this pot (not folded, contributed enough). */
  eligible: number[];
}

export interface PotResult extends Pot {
  winners: number[];
  payouts: Record<number, number>;
}

export interface HandLogEntry {
  seat: number;
  street: Street;
  type: ActionType | 'sb' | 'bb' | 'refund' | 'win' | 'muck';
  /** For bets/raises: total street bet after the action. For calls/blinds/refunds/wins: chips moved. */
  amount?: number;
  allIn?: boolean;
  auto?: boolean;
}

export interface HandResult {
  uncontested: boolean;
  pots: PotResult[];
  /** Net winnings per seat (payout minus committed). */
  net: Record<number, number>;
}

export interface HandState {
  number: number;
  dealer: number;
  /** Seat that posted the small blind (dealer when heads-up). */
  sbSeat: number;
  bbSeat: number;
  blinds: BlindLevel;
  street: Street;
  phase: HandPhase;
  /** Hand participants ordered by seat number (clockwise). */
  seats: HandSeat[];
  toAct: number | null;
  /** Highest bet on the current street that players must match. */
  currentBet: number;
  /** Size of the last full bet/raise on this street (minimum raise increment). */
  minRaise: number;
  /** True when fewer than two players can still bet; remaining streets need no betting. */
  bettingClosed: boolean;
  /** Stacks at the start of the hand (confirmed balances). */
  startStacks: Record<number, number>;
  log: HandLogEntry[];
  result: HandResult | null;
}

export interface Elimination {
  seat: number;
  place: number;
  hand: number;
}

export interface TournamentState {
  config: TournamentConfig;
  /** All seats that have taken part (including late joiners), ascending. */
  seats: number[];
  /** Confirmed chip balances (as of the last completed hand). */
  chips: Record<number, number>;
  startPlayerCount: number;
  levelIndex: number;
  startedAt: number;
  pausedMs: number;
  pausedAt: number | null;
  handCount: number;
  /** Seat of the dealer for the first hand. */
  firstDealer: number;
  lastBbSeat: number | null;
  eliminations: Elimination[];
  hand: HandState | null;
  finished: boolean;
  winner: number | null;
}

export interface LegalActions {
  seat: number;
  canFold: boolean;
  canCheck: boolean;
  /** Chips needed to call (capped at stack). 0 when checking is possible. */
  callAmount: number;
  /** True when calling puts the player all-in. */
  callIsAllIn: boolean;
  /** 'bet' when no bet this street, 'raise' otherwise, null when no aggressive action allowed. */
  aggressive: 'bet' | 'raise' | null;
  /** Minimum legal total for bet/raise-to (already capped by stack). */
  minTo: number;
  /** Minimum full bet/raise-to ignoring the stack; an all-in below this is a short all-in. */
  fullMinTo: number;
  /** Maximum legal total (= all-in). */
  maxTo: number;
  canAllIn: boolean;
  /** Current street bet of the player. */
  currentBet: number;
  /** Highest street bet. */
  tableBet: number;
  potTotal: number;
}
