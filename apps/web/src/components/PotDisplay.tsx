import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { useGame } from './game-context';

/** Total pot prominently; tap to expand main/side pot breakdown. */
export function PotDisplay() {
  const { room } = useGame();
  const { t, n } = useI18n();
  const [open, setOpen] = useState(false);
  const hand = room.game?.hand;
  if (!hand || hand.phase === 'complete') return null;
  const total = hand.seats.reduce((a, s) => a + s.committed, 0);
  const pots = room.pots;
  return (
    <button className="pot" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t('game.potBreakdown')}>
      <span className="pot-label">{t('game.pot')}</span>
      <span className="pot-total">{n(total)}</span>
      {pots.length > 1 && <span className="pot-more">{open ? '▴' : `▾ ${pots.length}`}</span>}
      {open && pots.length > 0 && (
        <span className="pot-list">
          {pots.map((p, i) => (
            <span key={i} className="pot-row">
              <span>{i === 0 ? t('game.mainPot') : t('game.sidePot', { n: i })}</span>
              <b>{n(p.amount)}</b>
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
