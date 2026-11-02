export type EngineErrorCode =
  | 'NO_HAND'
  | 'HAND_IN_PROGRESS'
  | 'WRONG_PHASE'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_ACTION'
  | 'INVALID_AMOUNT'
  | 'BET_TOO_SMALL'
  | 'BET_TOO_LARGE'
  | 'INVALID_WINNERS'
  | 'NOT_ENOUGH_PLAYERS'
  | 'TOURNAMENT_FINISHED'
  | 'INVALID_CONFIG'
  | 'INVALID_SEAT'
  | 'CANNOT_MUCK';

/** Errors carry stable codes; user-facing text lives in the i18n package (`error.<code>`). */
export class EngineError extends Error {
  constructor(public readonly code: EngineErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'EngineError';
  }
}
