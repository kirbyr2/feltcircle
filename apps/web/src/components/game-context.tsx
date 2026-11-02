import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { Command, RoomView } from '@feltcircle/game-protocol';
import type { GameSession, SessionSnapshot } from '@feltcircle/game-session';
import { useSnapshot } from '../lib/session';
import { useI18n } from '../lib/i18n';
import { useToast } from './ui';
import { seatName } from '../lib/format';

export interface GameCtx {
  session: GameSession;
  snap: SessionSnapshot;
  room: RoomView;
  local: boolean;
  isHost: boolean;
  mySeat: number | null;
  /** Commands may be sent (local, or online and connected). */
  canSend: boolean;
  send(cmd: Command): Promise<boolean>;
  name(seat: number): string;
}

const Ctx = createContext<GameCtx | null>(null);

export function GameProvider({ session, children }: { session: GameSession; children: (ctx: GameCtx | null) => ReactNode }) {
  const snap = useSnapshot(session);
  const { t } = useI18n();
  const toast = useToast();
  const send = useCallback(
    async (cmd: Command) => {
      const r = await session.send(cmd);
      if (!r.ok && r.error) toast(t(`error.${r.error}`), 'error');
      return r.ok;
    },
    [session, t, toast],
  );
  const value = useMemo<GameCtx | null>(() => {
    if (!snap.room) return null;
    const room = snap.room;
    return {
      session,
      snap,
      room,
      local: snap.local,
      isHost: snap.isHost,
      mySeat: snap.mySeat,
      canSend: snap.local || (snap.connection === 'online' && !snap.pending),
      send,
      name: (seat: number) => seatName(t, room, seat),
    };
  }, [snap, session, send, t]);
  return <Ctx.Provider value={value}>{children(value)}</Ctx.Provider>;
}

export function useGame(): GameCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('GameProvider missing');
  return v;
}
