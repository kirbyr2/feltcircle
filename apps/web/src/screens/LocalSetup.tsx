import { useMemo, useState } from 'react';
import { DEFAULT_SETTINGS, type RoomSettings } from '@feltcircle/game-protocol';
import type { SeatChips } from '@feltcircle/chip-export';
import { applyCommand, createLocalRoom, type RoomState } from '@feltcircle/room-core';
import { useI18n } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Advanced, BlindFields, blindsValid, ProgressionFields, type BlindValues } from '../components/Dialogs';
import { Brand, NumberField, useToast } from '../components/ui';

export interface LocalSetupInitial {
  settings?: Partial<RoomSettings>;
  nicknames?: Record<number, string>;
  seats?: number[];
}

/** Configure and start a Local Mode game (optionally from imported chips). */
export function LocalSetup({ imported, initial, onStart }: { imported: SeatChips | null; initial?: LocalSetupInitial; onStart: (state: RoomState) => Promise<void> }) {
  const { t, n } = useI18n();
  const toast = useToast();
  const base = { ...DEFAULT_SETTINGS, ...(initial?.settings ?? {}) };
  const [count, setCount] = useState(initial?.seats?.length ?? 6);
  const [chips, setChips] = useState(base.startingChips);
  const [blinds, setBlinds] = useState<BlindValues>({ sb: base.sb, bb: base.bb, progression: base.progression, levelMinutes: base.levelMinutes });
  const [names, setNames] = useState<Record<number, string>>(initial?.nicknames ?? {});
  const seats = useMemo(
    () =>
      imported
        ? Object.keys(imported)
            .map(Number)
            .sort((a, b) => a - b)
        : Array.from({ length: count }, (_, i) => i + 1),
    [imported, count],
  );
  const [dealer, setDealer] = useState<number>(seats[0]);
  const funded = imported ? seats.filter((s) => imported[s] > 0) : seats;

  const start = async () => {
    const settings: RoomSettings = {
      ...base,
      ...blinds,
      startingChips: chips,
      maxPlayers: Math.max(2, ...seats),
    };
    let s = createLocalRoom({ settings, players: seats.map((seat) => ({ seat, nickname: names[seat] ?? '' })), chips: imported ?? undefined, now: Date.now() });
    const r = applyCommand(s, { seat: null, local: true }, { type: 'host:start', dealerSeat: funded.includes(dealer) ? dealer : funded[0] }, Date.now());
    if (!r.ok) {
      toast(t(`error.${r.error}`), 'error');
      return;
    }
    s = r.state;
    await onStart(s);
    navigate('local', true);
  };

  return (
    <div className="screen setup">
      <div className="row between">
        <button className="btn btn-small" onClick={() => navigate('games/local')}>
          ‹ {t('common.back')}
        </button>
        <Brand small />
      </div>
      <h2 className="gold-text">{t('setup.localTitle')}</h2>
      <p className="muted small">♠ {t('games.texas.name')}</p>
      {imported ? (
        <p className="note">{t('setup.importActive')}</p>
      ) : (
        <div className="grid2">
          <NumberField label={t('setup.players')} value={count} min={2} max={10} onChange={setCount} />
          <NumberField label={t('setup.startingChips')} value={chips} min={1} onChange={setChips} hint={t('setup.stackInfo', { n: n(Math.floor(chips / Math.max(1, blinds.bb))) })} />
        </div>
      )}
      <BlindFields value={blinds} onChange={setBlinds} />
      <Advanced>
        <ProgressionFields value={blinds} onChange={setBlinds} />
      </Advanced>
      <div className="field">
        <span>{t('setup.nicknames')}</span>
        <div className="names">
          {seats.map((seat) => (
            <label key={seat} className="name-row">
              <span className="seat-no">{seat}</span>
              <input maxLength={20} placeholder={t('common.player', { n: seat })} value={names[seat] ?? ''} onChange={(e) => setNames({ ...names, [seat]: e.target.value })} />
              {imported && <span className="muted small num">{n(imported[seat])}</span>}
            </label>
          ))}
        </div>
      </div>
      <label className="field">
        <span>{t('setup.firstDealer')}</span>
        <select value={dealer} onChange={(e) => setDealer(Number(e.target.value))}>
          {funded.map((s) => (
            <option key={s} value={s}>
              {names[s] || t('common.player', { n: s })}
            </option>
          ))}
        </select>
      </label>
      <button className="btn btn-gold btn-big btn-block" disabled={!blindsValid(blinds) || funded.length < 2} onClick={start}>
        {t('setup.start')}
      </button>
    </div>
  );
}
