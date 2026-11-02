import { useState } from 'react';
import { DEFAULT_SETTINGS, type Language } from '@feltcircle/game-protocol';
import { createRoomRequest, ServerSession } from '@feltcircle/game-session';
import type { ImportResolution, SeatChips } from '@feltcircle/chip-export';
import { LOCALES } from '@feltcircle/i18n';
import { useI18n } from '../lib/i18n';
import { navigate } from '../lib/router';
import { rememberRoom, tokenStore } from '../lib/backend';
import { Advanced, BlindFields, blindsValid, ProgressionFields, type BlindValues } from '../components/Dialogs';
import { Brand, NumberField, useToast } from '../components/ui';
import { openRoomSession } from './Room';

export function CreateRoom({ baseUrl, imported, clearImported }: { baseUrl: string; imported: SeatChips | null; clearImported: () => void }) {
  const { t, n, locale } = useI18n();
  const toast = useToast();
  const importMax = imported ? Math.max(...Object.keys(imported).map(Number)) : 2;
  const [maxPlayers, setMaxPlayers] = useState(Math.max(DEFAULT_SETTINGS.maxPlayers, importMax));
  const [chips, setChips] = useState(DEFAULT_SETTINGS.startingChips);
  const [blinds, setBlinds] = useState<BlindValues>({ sb: DEFAULT_SETTINGS.sb, bb: DEFAULT_SETTINGS.bb, progression: DEFAULT_SETTINGS.progression, levelMinutes: DEFAULT_SETTINGS.levelMinutes });
  const [language, setLanguage] = useState<Language>(locale as Language);
  const [nickname, setNickname] = useState('');
  const [missing, setMissing] = useState<ImportResolution['missing']>('starting');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const r = await createRoomRequest(baseUrl, {
      game: 'texas-holdem',
      settings: { ...blinds, maxPlayers: Math.max(maxPlayers, importMax), startingChips: chips, defaultLanguage: language },
      nickname,
    });
    if (!r.ok) {
      setBusy(false);
      toast(t(`error.${r.error}`), 'error');
      return;
    }
    const { roomId, token } = r.room;
    tokenStore(baseUrl).set(roomId, token);
    rememberRoom(baseUrl, roomId);
    const session: ServerSession = openRoomSession(baseUrl, roomId);
    if (imported) {
      // Stage the imported distribution once connected; applied when the game starts.
      const unsub = session.subscribe(() => {
        if (session.getSnapshot().connection === 'online' && session.getSnapshot().mySeat === 1) {
          unsub();
          void session.send({ type: 'host:import', seats: imported, resolution: { missing } }).then((res) => {
            if (res.ok) clearImported();
            else toast(t(`error.${res.error}`), 'error');
          });
        }
      });
    }
    navigate(`room/${roomId}`, true);
  };

  return (
    <div className="screen setup">
      <div className="row between">
        <button className="btn btn-small" onClick={() => navigate('games/online')}>
          ‹ {t('common.back')}
        </button>
        <Brand small />
      </div>
      <h2 className="gold-text">{t('setup.onlineTitle')}</h2>
      <p className="muted small">♠ {t('games.texas.name')}</p>
      <label className="field">
        <span>{t('setup.yourNickname')}</span>
        <input maxLength={20} value={nickname} placeholder={t('common.player', { n: 1 })} onChange={(e) => setNickname(e.target.value)} />
      </label>
      <div className="grid2">
        <NumberField label={t('setup.maxPlayers')} value={maxPlayers} min={Math.max(2, importMax)} max={10} onChange={setMaxPlayers} />
        {!imported && <NumberField label={t('setup.startingChips')} value={chips} min={1} onChange={setChips} hint={t('setup.stackInfo', { n: n(Math.floor(chips / Math.max(1, blinds.bb))) })} />}
      </div>
      <BlindFields value={blinds} onChange={setBlinds} />
      <Advanced>
        <ProgressionFields value={blinds} onChange={setBlinds} />
        <label className="field">
          <span>{t('setup.defaultLanguage')}</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
            {LOCALES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </Advanced>
      {imported && (
        <div className="card">
          <p className="note">{t('lobby.importStaged')}</p>
          <p className="muted small">{t('import.missingLater', { seats: Object.keys(imported).join(', ') })}</p>
          <label className="radio">
            <input type="radio" checked={missing === 'starting'} onChange={() => setMissing('starting')} /> {t('import.missingStarting')}
          </label>
          <label className="radio">
            <input type="radio" checked={missing === 'zero'} onChange={() => setMissing('zero')} /> {t('import.missingZero')}
          </label>
        </div>
      )}
      <button className="btn btn-gold btn-big btn-block" disabled={busy || !blindsValid(blinds)} onClick={create}>
        {t('setup.create')}
      </button>
    </div>
  );
}
