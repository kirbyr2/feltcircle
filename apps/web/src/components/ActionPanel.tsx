import { useState } from 'react';
import { legalActions, streetToDeal, type PlayerAction } from '@feltcircle/poker-engine';
import { useI18n } from '../lib/i18n';
import { useGame } from './game-context';
import { BetSlider } from './BetSlider';
import { PreActionNotice } from './Panels';

/** Fold / Check / Call / Bet-Raise / All-in for the player to act. */
export function ActionPanel({ seat }: { seat: number }) {
  const { room, send, canSend, local, name } = useGame();
  const { t, n } = useI18n();
  const [sliding, setSliding] = useState<null | 'min' | 'max'>(null);
  const [busy, setBusy] = useState(false);
  const hand = room.game!.hand!;
  const legal = legalActions(hand, seat);
  if (!legal) return null;
  // First decision of the flop/turn/river: the table deals those cards before acting.
  const deal = streetToDeal(hand);

  const act = async (action: PlayerAction) => {
    if (busy) return;
    setBusy(true);
    // Local Mode names the seat explicitly so a double tap can never act for the next player.
    const ok = await send(local ? { type: 'act', action, seat } : { type: 'act', action });
    setBusy(false);
    if (ok) setSliding(null);
  };
  const disabled = !canSend || busy;

  if (sliding && legal.aggressive) {
    return (
      <div className="panel action-panel">
        <div className="panel-title">{local ? t('action.actingFor', { name: name(seat) }) : t('game.yourTurn')}</div>
        <BetSlider
          legal={legal}
          bigBlind={hand.blinds.bb}
          disabled={disabled}
          initial={sliding === 'max' ? legal.maxTo : undefined}
          onCancel={() => setSliding(null)}
          onConfirm={(amount) => act(amount === legal.maxTo ? { type: 'allin' } : { type: legal.aggressive!, amount })}
        />
      </div>
    );
  }

  return (
    <div className="panel action-panel">
      <div className="panel-title">
        {local ? t('action.actingFor', { name: name(seat) }) : t('game.yourTurn')}
        {legal.callAmount > 0 && <span className="muted"> · {t('game.bet', { amount: n(legal.tableBet) })}</span>}
      </div>
      {deal && (
        <p className="deal-note" role="status">
          {local ? t(`deal.${deal}Local`, { name: name(seat) }) : t(`deal.${deal}You`)}
        </p>
      )}
      {!local && <PreActionNotice />}
      <div className="action-row">
        <button className="btn btn-fold" disabled={disabled} onClick={() => act({ type: 'fold' })}>
          {t('action.fold')}
        </button>
        {legal.canCheck ? (
          <button className="btn btn-check" disabled={disabled} onClick={() => act({ type: 'check' })}>
            {t('action.check')}
          </button>
        ) : (
          <button className="btn btn-check" disabled={disabled} onClick={() => act({ type: 'call' })}>
            {legal.callIsAllIn ? t('action.callAllIn', { amount: n(legal.callAmount) }) : t('action.call', { amount: n(legal.callAmount) })}
          </button>
        )}
        {legal.aggressive && (
          <button className="btn btn-gold" disabled={disabled} onClick={() => setSliding('min')}>
            {legal.aggressive === 'bet' ? t('action.bet') : t('action.raise')}
          </button>
        )}
        {legal.aggressive && (
          <button className="btn btn-allin" disabled={disabled} onClick={() => setSliding('max')}>
            {t('action.allIn')} {n(legal.maxTo)}
          </button>
        )}
      </div>
    </div>
  );
}
