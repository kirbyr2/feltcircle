import type { BlindLevel, BlindProgression, TournamentConfig, TournamentState } from './types.js';

/** Relative blind ladder (multiples of the starting small blind). */
const LADDER = [1, 2, 3, 5, 10, 15, 20, 30, 40, 50, 70, 100, 150, 200, 300, 500, 700, 1000];

export const DEFAULT_STARTING_CHIPS = 2000;
export const DEFAULT_SB = 10;
export const DEFAULT_BB = 20;
export const DEFAULT_LEVEL_MINUTES = 15;

/** Generate a blind ladder from a starting small/big blind. */
/**
 * Eliminations per blind level for player-based progression, derived from the
 * number of starting players so every table reaches a similar final level:
 * 2–7 players → 1, 8–11 → 2. For six players this gives the reference ladder
 * 6→10/20, 5→20/40, 4→30/60, 3→50/100, 2→100/200.
 */
export function playersPerLevelFor(players: number): number {
  return Math.max(1, Math.round((players - 2) / 4));
}

export function generateLevels(sb: number, bb: number): BlindLevel[] {
  const ratio = bb / sb;
  return LADDER.map((m) => ({ sb: sb * m, bb: Math.round(sb * m * ratio) }));
}

/**
 * Default config: 2,000 chips, 10/20, hybrid progression, 15-minute levels,
 * one level per elimination. For six players this yields
 * 6→10/20, 5→20/40, 4→30/60, 3→50/100, 2→100/200.
 */
export function defaultConfig(overrides: Partial<TournamentConfig> & { sb?: number; bb?: number } = {}): TournamentConfig {
  const { sb = DEFAULT_SB, bb = DEFAULT_BB, ...rest } = overrides;
  return {
    startingChips: DEFAULT_STARTING_CHIPS,
    levels: generateLevels(sb, bb),
    progression: 'hybrid',
    levelMinutes: DEFAULT_LEVEL_MINUTES,
    playersPerLevel: 1,
    ...rest,
  };
}

export function validateConfig(c: TournamentConfig): string | null {
  const isPosInt = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  if (!isPosInt(c.startingChips) || c.startingChips > 1e9) return 'startingChips';
  if (!Array.isArray(c.levels) || c.levels.length === 0 || c.levels.length > 100) return 'levels';
  for (const l of c.levels) {
    if (!isPosInt(l.sb) || !isPosInt(l.bb) || l.sb >= l.bb || l.bb > 1e9) return 'levels';
  }
  if (!(['time', 'players', 'hybrid', 'fixed'] as BlindProgression[]).includes(c.progression)) return 'progression';
  if (!isPosInt(c.levelMinutes) || c.levelMinutes > 24 * 60) return 'levelMinutes';
  if (!isPosInt(c.playersPerLevel) || c.playersPerLevel > 10) return 'playersPerLevel';
  return null;
}

/** Active (not paused) milliseconds since the tournament started. */
export function elapsedMs(t: TournamentState, now: number): number {
  const pausedNow = t.pausedAt !== null ? Math.max(0, now - t.pausedAt) : 0;
  return Math.max(0, now - t.startedAt - t.pausedMs - pausedNow);
}

export function remainingPlayers(t: TournamentState): number {
  return t.seats.filter((s) => (t.chips[s] ?? 0) > 0).length;
}

/**
 * Level that should apply for the next hand. Hybrid uses the highest level
 * reached by time or by eliminations. Levels never decrease.
 */
export function levelFor(t: TournamentState, now: number): number {
  const c = t.config;
  if (c.progression === 'fixed') return Math.min(c.levels.length - 1, t.levelIndex);
  let target = 0;
  if (c.progression === 'time' || c.progression === 'hybrid') {
    target = Math.max(target, Math.floor(elapsedMs(t, now) / (c.levelMinutes * 60_000)));
  }
  if (c.progression === 'players' || c.progression === 'hybrid') {
    const eliminated = t.startPlayerCount - remainingPlayers(t);
    target = Math.max(target, Math.floor(eliminated / c.playersPerLevel));
  }
  return Math.min(c.levels.length - 1, Math.max(t.levelIndex, target));
}

/** Milliseconds until the next time-based level (null when not time-driven or at the last level). */
export function msUntilNextLevel(t: TournamentState, now: number): number | null {
  const c = t.config;
  if (c.progression === 'players' || c.progression === 'fixed') return null;
  if (t.levelIndex >= c.levels.length - 1) return null;
  const per = c.levelMinutes * 60_000;
  const e = elapsedMs(t, now);
  const nextBoundary = (Math.floor(e / per) + 1) * per;
  return nextBoundary - e;
}
