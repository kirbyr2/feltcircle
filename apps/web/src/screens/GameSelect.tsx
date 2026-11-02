import { GAME_CATALOG, type GameId } from '@feltcircle/game-protocol';
import { useI18n } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Brand } from '../components/ui';

const ICONS: Record<GameId, string> = { 'texas-holdem': '♠', 'riichi-mahjong': '中' };
const KEYS: Record<GameId, string> = { 'texas-holdem': 'texas', 'riichi-mahjong': 'mahjong' };

/** The same game catalog for Local Mode and Online Multiplayer. */
export function GameSelect({ mode, onSelect }: { mode: 'local' | 'online'; onSelect?: (game: GameId) => void }) {
  const { t } = useI18n();
  const pick = (game: GameId) => {
    if (onSelect) onSelect(game);
    else navigate(mode === 'local' ? 'local/new' : 'online/new');
  };
  return (
    <div className="screen setup">
      <div className="row between">
        <button className="btn btn-small" onClick={() => navigate('')}>
          ‹ {t('common.back')}
        </button>
        <Brand small />
      </div>
      <h2 className="gold-text">{t('games.title')}</h2>
      <p className="muted small">{mode === 'local' ? t('home.local') : t('home.online')}</p>
      <div className="col gap">
        {GAME_CATALOG.map((g) => {
          const k = KEYS[g.id];
          return (
            <button
              key={g.id}
              className={`card game-card ${g.available ? '' : 'disabled'}`}
              disabled={!g.available}
              aria-disabled={!g.available}
              data-game={g.id}
              onClick={() => g.available && pick(g.id)}
            >
              <span className="game-icon" aria-hidden>
                {ICONS[g.id]}
              </span>
              <span className="grow">
                <b>{t(`games.${k}.name`)}</b>
                <span className="muted small block">{t(`games.${k}.desc`)}</span>
              </span>
              <span className={`tag ${g.available ? 'tag-ok' : 'tag-soon'}`}>{g.available ? t('games.available') : t('games.comingSoon')}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
