import { useState, type ReactNode } from 'react';
import type { BlindProgression, HandLogEntry } from '@feltcircle/poker-engine';
import type { RoomView } from '@feltcircle/game-protocol';
import { useI18n } from '../lib/i18n';
import { seatName } from '../lib/format';
import { LanguageSelect, Modal, NumberField, Segmented } from './ui';
import { HandRankingsDialog } from './HandRankings';
import { SoundSettings } from './Sound';

export interface BlindValues {
  sb: number;
  bb: number;
  progression: BlindProgression;
  levelMinutes: number;
}

export const blindsValid = (v: { sb: number; bb: number }) => v.sb >= 1 && v.bb > v.sb;

/** Small/big blind (main settings). The big blind must be larger than the small blind. */
export function BlindFields({ value, onChange }: { value: BlindValues; onChange: (v: BlindValues) => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="grid2">
        <NumberField label={t('setup.smallBlind')} value={value.sb} min={1} onChange={(sb) => onChange({ ...value, sb })} />
        <NumberField label={t('setup.bigBlind')} value={value.bb} min={2} onChange={(bb) => onChange({ ...value, bb })} />
      </div>
      {!blindsValid(value) && <p className="error small">{t('setup.blindError')}</p>}
    </>
  );
}

/** Blind progression strategy and interval (advanced settings). */
export function ProgressionFields({ value, onChange }: { value: BlindValues; onChange: (v: BlindValues) => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="field">
        <span>{t('setup.progression')}</span>
        <Segmented
          value={value.progression}
          onChange={(progression) => onChange({ ...value, progression })}
          options={[
            { value: 'hybrid', label: t('setup.progression.hybrid') },
            { value: 'time', label: t('setup.progression.time') },
            { value: 'players', label: t('setup.progression.players') },
            { value: 'fixed', label: t('setup.progression.fixed') },
          ]}
        />
        <small className="muted">{t(`setup.progressionHint.${value.progression}`)}</small>
      </div>
      {(value.progression === 'time' || value.progression === 'hybrid') && (
        <NumberField label={t('setup.levelMinutes')} value={value.levelMinutes} min={1} max={1440} onChange={(levelMinutes) => onChange({ ...value, levelMinutes })} />
      )}
    </>
  );
}

/** Collapsed "Advanced settings" section. */
export function Advanced({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <details className="advanced">
      <summary>{t('setup.advanced')}</summary>
      <div className="col gap">{children}</div>
    </details>
  );
}

export function BlindsDialog({ room, onApply, onClose }: { room: RoomView; onApply: (v: BlindValues) => Promise<boolean>; onClose: () => void }) {
  const { t } = useI18n();
  const g = room.game;
  const cur = g ? g.config.levels[g.levelIndex] : { sb: room.settings.sb, bb: room.settings.bb };
  const [v, setV] = useState<BlindValues>({
    sb: cur.sb,
    bb: cur.bb,
    progression: room.settings.progression,
    levelMinutes: room.settings.levelMinutes,
  });
  return (
    <Modal title={t('host.blinds')} onClose={onClose}>
      <p className="muted small">{t('host.blindsNote')}</p>
      <BlindFields value={v} onChange={setV} />
      <ProgressionFields value={v} onChange={setV} />
      <div className="row gap">
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-gold btn-big" disabled={!blindsValid(v)} onClick={async () => (await onApply(v)) && onClose()}>
          {t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

export function logText(t: (k: string, p?: Record<string, string | number>) => string, n: (x: number) => string, e: HandLogEntry): string {
  const amount = e.amount !== undefined ? n(e.amount) : '';
  const base = t(`log.${e.type}`, { amount });
  return e.auto ? `${base} ${t('log.auto')}` : base;
}

export function HistoryDialog({ room, onClose }: { room: RoomView; onClose: () => void }) {
  const { t, n } = useI18n();
  const hand = room.game?.hand;
  const name = (s: number) => seatName(t, room, s);
  return (
    <Modal title={t('common.history')} onClose={onClose}>
      {hand && (
        <>
          <div className="panel-title">{t('game.hand', { n: hand.number })}</div>
          <ol className="history">
            {hand.log.map((e, i) => (
              <li key={i}>
                <span className="muted">{t(`street.${e.street}`)}</span> <b>{name(e.seat)}</b> {logText(t, n, e)}
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="panel-title">{t('host.menu')}</div>
      <ol className="history">
        {[...room.log].reverse().map((e, i) => (
          <li key={i}>
            <span className="muted">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>{' '}
            {t(`roomlog.${e.code}`, {
              ...Object.fromEntries(Object.entries(e.params ?? {}).map(([k, v]) => [k, typeof v === 'number' && ['chips', 'from', 'to', 'sb', 'bb'].includes(k) ? n(v) : v])),
              ...(e.params?.street ? { street: t(`street.${e.params.street}`) } : {}),
              ...(e.seat !== null ? { name: name(e.seat) } : {}),
            })}
          </li>
        ))}
      </ol>
    </Modal>
  );
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [hands, setHands] = useState(false);
  if (hands) return <HandRankingsDialog onClose={() => setHands(false)} />;
  return (
    <Modal title={t('common.help')} onClose={onClose}>
      <ol className="help">
        {[1, 2, 3, 4, 5, 6, 7].map((i) => (
          <li key={i}>{t(`help.${i}`)}</li>
        ))}
      </ol>
      <button className="btn btn-block" onClick={() => setHands(true)}>
        ♠ {t('hands.title')}
      </button>
    </Modal>
  );
}

/** Personal device settings: language and sound. Never affects the game or other players. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t('settings.title')} onClose={onClose}>
      <LanguageSelect />
      <p className="muted small">{t('settings.languageNote')}</p>
      <SoundSettings />
    </Modal>
  );
}
