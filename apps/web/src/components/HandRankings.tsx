import { useI18n } from '../lib/i18n';
import { Modal } from './ui';

/** The ten standard hand categories, strongest first, with a five-card example. */
export const HAND_CATEGORIES = [
  { id: 'royalFlush', cards: ['A♠', 'K♠', 'Q♠', 'J♠', '10♠'] },
  { id: 'straightFlush', cards: ['9♥', '8♥', '7♥', '6♥', '5♥'] },
  { id: 'fourKind', cards: ['Q♣', 'Q♦', 'Q♥', 'Q♠', '7♦'] },
  { id: 'fullHouse', cards: ['K♠', 'K♥', 'K♦', '4♣', '4♠'] },
  { id: 'flush', cards: ['A♦', 'J♦', '8♦', '6♦', '2♦'] },
  { id: 'straight', cards: ['10♣', '9♦', '8♠', '7♥', '6♣'] },
  { id: 'threeKind', cards: ['8♣', '8♥', '8♠', 'K♦', '3♠'] },
  { id: 'twoPair', cards: ['J♥', 'J♣', '5♠', '5♦', 'A♣'] },
  { id: 'pair', cards: ['10♠', '10♥', 'A♦', '7♣', '4♥'] },
  { id: 'highCard', cards: ['A♣', 'Q♦', '9♠', '6♥', '3♣'] },
] as const;

export const HAND_RULES = ['best5', 'kickers', 'ties', 'split', 'aceStraight', 'flush', 'suits'] as const;

/** Lightweight CSS playing card (illustration only; FeltCircle never deals or evaluates cards). */
export function PlayingCard({ card, dim }: { card: string; dim?: boolean }) {
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const red = suit === '♥' || suit === '♦';
  return (
    <span className={`pcard ${red ? 'red' : ''} ${dim ? 'dim' : ''}`} aria-label={card}>
      <span className="pcard-rank">{rank}</span>
      <span className="pcard-suit">{suit}</span>
    </span>
  );
}

/** Which example cards form the category (the rest are kickers, shown dimmed). */
const MADE: Record<string, number> = { fourKind: 4, fullHouse: 5, threeKind: 3, twoPair: 4, pair: 2, highCard: 1 };

export function HandRankingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t('hands.title')} onClose={onClose} wide>
      <p className="muted small">{t('hands.intro')}</p>
      <ol className="hand-list">
        {HAND_CATEGORIES.map((h, i) => (
          <li key={h.id} className="hand-row">
            <div className="hand-head">
              <span className="hand-rank">{i + 1}</span>
              <b>{t(`hands.${h.id}.name`)}</b>
            </div>
            <div className="hand-cards">
              {h.cards.map((c, j) => (
                <PlayingCard key={c} card={c} dim={j >= (MADE[h.id] ?? 5)} />
              ))}
            </div>
            <p className="muted small">{t(`hands.${h.id}.desc`)}</p>
          </li>
        ))}
      </ol>
      <div className="panel-title">{t('hands.rulesTitle')}</div>
      <ul className="help">
        {HAND_RULES.map((r) => (
          <li key={r}>{t(`hands.rule.${r}`)}</li>
        ))}
      </ul>
      <p className="muted small">{t('hands.note')}</p>
    </Modal>
  );
}
