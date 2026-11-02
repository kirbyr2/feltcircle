import { useEffect, useState } from 'react';
import { LocalSession } from '@feltcircle/game-session';
import type { RoomState } from '@feltcircle/room-core';
import { kvDel, kvGet, kvSet } from '../lib/storage';
import { navigate } from '../lib/router';
import { useI18n } from '../lib/i18n';
import { GameProvider } from '../components/game-context';
import { Spinner } from '../components/ui';
import { GameScreen } from './GameScreen';
import { LocalSetup } from './LocalSetup';

export const LOCAL_KEY = 'localGame';

let current: LocalSession | null = null;

export function localStore() {
  return {
    save: (s: RoomState) => kvSet(LOCAL_KEY, s),
    clear: () => kvDel(LOCAL_KEY),
  };
}

export function setLocalSession(s: RoomState) {
  current?.dispose();
  current = new LocalSession(s, localStore());
}

export async function hasSavedLocalGame(): Promise<boolean> {
  const s = await kvGet<RoomState>(LOCAL_KEY);
  return !!s && s.schema === 1;
}

export function LocalGame({ onChanged }: { onChanged: () => void }) {
  const { t, setRoomDefault } = useI18n();
  const [session, setSession] = useState<LocalSession | null>(current);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (session) return;
    void kvGet<RoomState>(LOCAL_KEY).then((s) => {
      if (s && s.schema === 1) {
        current?.dispose();
        current = new LocalSession(s, localStore());
        setSession(current);
      } else setMissing(true);
    });
  }, [session]);
  useEffect(() => {
    if (missing) navigate('local/new', true);
  }, [missing]);
  useEffect(() => {
    setRoomDefault(session?.roomState.settings.defaultLanguage ?? null);
    return () => setRoomDefault(null);
  }, [session, setRoomDefault]);

  if (!session) return <Spinner label={t('common.loading')} />;
  const discard = async () => {
    await kvDel(LOCAL_KEY);
    current?.dispose();
    current = null;
    onChanged();
    navigate('', true);
  };
  return (
    <GameProvider session={session}>
      {(ctx) =>
        !ctx ? (
          <Spinner />
        ) : ctx.room.status === 'lobby' ? (
          <LocalSetup
            imported={null}
            initial={{
              settings: ctx.room.settings,
              seats: ctx.room.seats.map((s) => s.seat),
              nicknames: Object.fromEntries(ctx.room.seats.map((s) => [s.seat, s.nickname])),
            }}
            onStart={async (s) => {
              await kvSet(LOCAL_KEY, s);
              current?.dispose();
              current = new LocalSession(s, localStore());
              setSession(current);
              onChanged();
            }}
          />
        ) : (
          <GameScreen onDiscardLocal={discard} />
        )
      }
    </GameProvider>
  );
}
