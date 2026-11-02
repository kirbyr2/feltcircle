import { useCallback, useEffect, useState } from 'react';
import type { BackendStatus } from '@feltcircle/game-session';
import type { SeatChips } from '@feltcircle/chip-export';
import { probeBackend } from './lib/backend';
import { useRoute, navigate } from './lib/router';
import { Home } from './screens/Home';
import { LocalSetup } from './screens/LocalSetup';
import { LocalGame, hasSavedLocalGame, setLocalSession, LOCAL_KEY } from './screens/LocalGame';
import { CreateRoom } from './screens/CreateRoom';
import { JoinCode } from './screens/Join';
import { Room } from './screens/Room';
import { GameSelect } from './screens/GameSelect';
import { kvSet } from './lib/storage';

export function App() {
  const route = useRoute();
  const [backend, setBackend] = useState<BackendStatus>({ state: 'checking' });
  const [hasLocal, setHasLocal] = useState(false);
  const [imported, setImported] = useState<SeatChips | null>(null);

  // Backend detection never blocks startup; Local Mode is always available.
  const detect = useCallback(() => {
    setBackend({ state: 'checking' });
    void probeBackend().then(setBackend);
  }, []);
  useEffect(detect, [detect]);
  const refreshLocal = useCallback(() => void hasSavedLocalGame().then(setHasLocal), []);
  useEffect(refreshLocal, [refreshLocal, route.path.join('/')]);

  const [p0, p1] = route.path;
  if (p0 === 'games' && (p1 === 'local' || p1 === 'online')) {
    if (p1 === 'online' && backend.state === 'unavailable') navigate('', true);
    return <GameSelect mode={p1} />;
  }
  if (p0 === 'local' && p1 === 'new')
    return (
      <LocalSetup
        imported={imported}
        onStart={async (state) => {
          await kvSet(LOCAL_KEY, state);
          setLocalSession(state);
          setImported(null);
          refreshLocal();
        }}
      />
    );
  if (p0 === 'local') return <LocalGame onChanged={refreshLocal} />;
  if (p0 === 'online' && p1 === 'new') {
    if (backend.state !== 'available') {
      if (backend.state === 'unavailable') navigate('', true);
      return null;
    }
    return <CreateRoom baseUrl={backend.baseUrl} imported={imported} clearImported={() => setImported(null)} />;
  }
  if (p0 === 'join' && !p1) return <JoinCode />;
  if ((p0 === 'room' || p0 === 'join') && p1) {
    const base = backend.state === 'available' ? backend.baseUrl : null;
    return <Room key={p1} roomId={p1.toUpperCase()} defaultBase={base} unavailable={backend.state === 'unavailable'} serverParam={route.query.get('server')} />;
  }
  return <Home backend={backend} onRetry={detect} hasLocalGame={hasLocal} importedChips={imported} setImportedChips={setImported} />;
}
