import { useSyncExternalStore } from 'react';
import type { GameSession, SessionSnapshot } from '@feltcircle/game-session';

export function useSnapshot(session: GameSession): SessionSnapshot {
  return useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.getSnapshot(),
  );
}
