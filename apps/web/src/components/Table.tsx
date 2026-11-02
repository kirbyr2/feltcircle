import { displayStacks } from '@feltcircle/poker-engine';
import { useI18n } from '../lib/i18n';
import { useGame } from './game-context';
import { PotDisplay } from './PotDisplay';

/**
 * Where seat `index` of the ordered occupied seats sits around the in-game
 * table, in % of the table area: the anchor (the viewer, or the first seat)
 * at the bottom and the others clockwise, evenly spaced over `count`
 * positions. Depends only on the occupied seats, never on the room's capacity.
 */
export function tablePosition(index: number, count: number, anchorIndex: number) {
  const total = Math.max(1, count);
  const idx = (index - anchorIndex + total) % total;
  const angle = Math.PI / 2 + (idx / total) * Math.PI * 2;
  return {
    x: 50 + 44 * Math.cos(angle),
    y: 50 + 42 * Math.sin(angle),
    betX: 50 + 26 * Math.cos(angle),
    betY: 50 + 25 * Math.sin(angle),
  };
}

/**
 * Oval table with the seated players in clockwise physical order, evenly
 * spaced (empty seats are not shown: seats are renumbered without gaps when
 * the game starts). Online, the viewer's own seat is rotated to the bottom;
 * in Local Mode seat 1 is at the bottom.
 */
export function Table() {
  const { room, mySeat, name } = useGame();
  const { t, n } = useI18n();
  const g = room.game;
  const hand = g?.hand ?? null;
  const stacks = g ? displayStacks(g) : {};
  const seats = room.seats.map((s) => s.seat).sort((a, b) => a - b);
  const anchorIdx = Math.max(0, seats.indexOf(mySeat ?? seats[0]));
  const inHand = new Map(hand?.seats.map((s) => [s.seat, s]) ?? []);
  const live = hand && hand.phase !== 'complete';

  return (
    <div className="table-wrap">
      <div className="table-felt">
        <div className="table-center">
          {hand && live && <div className="street-badge">{t(hand.phase === 'showdown' ? 'street.showdown' : `street.${hand.street}`)}</div>}
          {hand && !live && <div className="street-badge muted-badge">{t('game.handOver')}</div>}
          <PotDisplay />
        </div>
      </div>
      {seats.map((seat, i) => {
        const { x, y, betX: bx, betY: by } = tablePosition(i, seats.length, anchorIdx);
        const sv = room.seats.find((s) => s.seat === seat)!;
        const hs = inHand.get(seat);
        const stack = stacks[seat] ?? 0;
        const out = g && g.seats.includes(seat) && stack === 0 && !(hs && live && (hs.committed > 0 || hs.allIn));
        const toAct = live && hand!.phase === 'betting' && hand!.toAct === seat;
        const classes = [
          'seat',
          toAct ? 'seat-active' : '',
          hs?.folded && live ? 'seat-folded' : '',
          out ? 'seat-out' : '',
          seat === mySeat ? 'seat-me' : '',
        ].join(' ');
        return (
          <div key={seat}>
            <div className={classes} style={{ left: `${x}%`, top: `${y}%` }}>
              <div className="seat-top">
                <span className="seat-no">{seat}</span>
                {room.hostSeat === seat && room.mode !== 'local' && <span className="tag tag-host" title={t('common.host')}>★</span>}
                {!sv.connected && <span className="tag tag-off">{t('common.offline')}</span>}
              </div>
              <div className="seat-name">{name(seat)}</div>
              <div className="seat-stack">{n(stack)}</div>
              <div className="seat-tags">
                {hand && hand.dealer === seat && <span className="marker marker-d">{t('common.dealer')}</span>}
                {hand && hand.sbSeat === seat && <span className="marker marker-sb">{t('common.sb')}</span>}
                {hand && hand.bbSeat === seat && <span className="marker marker-bb">{t('common.bb')}</span>}
                {hs?.allIn && live && <span className="tag tag-allin">{t('common.allIn')}</span>}
                {hs?.folded && live && <span className="tag">{hs.mucked ? t('common.mucked') : t('common.folded')}</span>}
                {live && hand!.phase === 'showdown' && room.showdown?.declarations[seat] && (
                  <span className="tag tag-claim">{room.showdown.declarations[seat] === 'win' ? t('showdown.win') : t('showdown.tie')}</span>
                )}
                {out && <span className="tag">{t('common.out')}</span>}
                {sv.autoFold && !out && <span className="tag tag-auto">{sv.away ? t('common.away') : t('common.autoFold')}</span>}
              </div>
            </div>
            {hs && live && hs.bet > 0 && (
              <div className="bet-chip" style={{ left: `${bx}%`, top: `${by}%` }}>
                {n(hs.bet)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
