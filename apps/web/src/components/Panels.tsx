import { useCallback, useEffect, useMemo, useState } from 'react';
import { Confirm } from './ui';
import type { PreAction } from '@feltcircle/game-protocol';
import { useI18n } from '../lib/i18n';
import { useGame } from './game-context';

/** Optional pre-actions while waiting (online). Selecting never bets immediately. */
export function PreActions({ seat }: { seat: number }) {
  const { room, send, canSend, name } = useGame();
  const { t } = useI18n();
  const hand = room.game!.hand!;
  const me = hand.seats.find((s) => s.seat === seat);
  if (!me || me.folded || me.allIn) return null;
  const current = room.myPreAction;
  const opts: { v: PreAction; label: string }[] = [
    { v: 'fold', label: t('pre.fold') },
    { v: 'checkfold', label: t('pre.checkfold') },
    { v: 'callany', label: t('pre.callany') },
  ];
  return (
    <div className="panel">
      <div className="panel-title">
        {hand.phase === 'betting' && hand.toAct !== null ? t('game.toAct', { name: name(hand.toAct) }) : t('street.waitHost')}
      </div>
      <div className="pre-row" role="group" aria-label={t('pre.title')}>
        {opts.map((o) => (
          <button
            key={o.v}
            className={`btn btn-pre ${current === o.v ? 'on' : ''}`}
            aria-pressed={current === o.v}
            disabled={!canSend}
            onClick={() => send({ type: 'setPreAction', preAction: current === o.v ? null : o.v })}
          >
            <span className="check-box">{current === o.v ? '✓' : ''}</span>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function WaitingPanel() {
  const { room, name } = useGame();
  const { t } = useI18n();
  const hand = room.game?.hand;
  return (
    <div className="panel">
      <div className="panel-title">{hand && hand.toAct !== null ? t('game.toAct', { name: name(hand.toAct) }) : t('common.loading')}</div>
    </div>
  );
}

/** Host confirms physical cards were dealt before the next betting round. */
export function StreetPanel() {
  const { room, isHost, send, canSend } = useGame();
  const { t } = useI18n();
  const hand = room.game!.hand!;
  const msg = hand.bettingClosed
    ? t('street.runout')
    : hand.street === 'preflop'
      ? t('street.dealFlop')
      : hand.street === 'flop'
        ? t('street.dealTurn')
        : t('street.dealRiver');
  if (!isHost) {
    return (
      <div className="panel">
        <div className="panel-title">{t('street.waitHost')}</div>
        <p className="muted small">{msg}</p>
      </div>
    );
  }
  return (
    <div className="panel">
      <p className="lead">{msg}</p>
      <button className="btn btn-gold btn-big btn-block" disabled={!canSend} onClick={() => send({ type: 'host:advance' })}>
        {hand.bettingClosed ? t('street.toShowdown') : t('street.confirm')}
      </button>
    </div>
  );
}

/**
 * Showdown. Players reveal their real cards; anyone still in a pot can press
 * "I won!" (or withdraw it) or "I lost / muck". Claims never move chips: the
 * host confirms the winner(s) of every pot and the engine pays out.
 */
export function ShowdownPanel() {
  const { room, isHost, local, mySeat, send, canSend, name } = useGame();
  const { t, n } = useI18n();
  const [mucking, setMucking] = useState(false);
  const pots = room.pots;
  const claims = room.claims;
  const suggestion = useCallback(
    () =>
      pots.map((p) => {
        if (p.eligible.length === 1) return [...p.eligible];
        const claimed = p.eligible.filter((s) => claims.includes(s));
        return claimed.length === 1 ? claimed : [];
      }),
    [pots, claims],
  );
  const key = JSON.stringify([pots, claims]);
  const [sel, setSel] = useState<number[][]>(suggestion);
  useEffect(() => setSel(suggestion()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = useMemo(() => sel.length === pots.length && sel.every((s) => s.length > 0), [sel, pots.length]);

  const contesting = !local && mySeat !== null && pots.some((p) => p.eligible.includes(mySeat));
  const claimed = mySeat !== null && claims.includes(mySeat);
  const potName = (i: number) => (i === 0 ? t('game.mainPot') : t('game.sidePot', { n: i }));

  const toggle = (i: number, seat: number) =>
    setSel((cur) => {
      const next = cur.map((x) => [...x]);
      const has = next[i].includes(seat);
      next[i] = has ? next[i].filter((s) => s !== seat) : [...next[i], seat].sort((a, b) => a - b);
      // Convenience: a winner of a larger pot also preselects smaller side pots they are eligible for.
      if (!has) for (let j = i + 1; j < pots.length; j++) if (next[j].length === 0 && pots[j].eligible.includes(seat)) next[j] = [seat];
      return next;
    });

  return (
    <div className="panel">
      <div className="panel-title">{t('showdown.title')}</div>
      <p className="muted small">{isHost ? `${t('showdown.select')} ${t('showdown.tieHint')}` : t('showdown.reveal')}</p>
      {pots.map((p, i) => (
        <div key={i} className="pot-select">
          <div className="pot-select-head">
            <span>{potName(i)}</span>
            <b>{n(p.amount)}</b>
          </div>
          <div className="chip-row">
            {p.eligible.map((seat) => {
              const badge = claims.includes(seat) ? <span className="claim-badge">⚑ {t('showdown.claimed')}</span> : null;
              return isHost ? (
                <button key={seat} className={`chip-btn ${sel[i]?.includes(seat) ? 'on' : ''}`} aria-pressed={sel[i]?.includes(seat)} onClick={() => toggle(i, seat)}>
                  <span className="seat-no">{seat}</span> {name(seat)} {badge}
                </button>
              ) : (
                <span key={seat} className={`chip-btn static ${claims.includes(seat) ? 'on' : ''}`}>
                  <span className="seat-no">{seat}</span> {name(seat)} {badge}
                </span>
              );
            })}
          </div>
        </div>
      ))}
      {contesting && (
        <div className="row gap-s">
          <button
            className={`btn btn-block ${claimed ? '' : 'btn-gold'}`}
            disabled={!canSend}
            aria-pressed={claimed}
            onClick={() => send({ type: 'claim', won: !claimed })}
          >
            {claimed ? t('showdown.withdraw') : t('showdown.iWon')}
          </button>
          <button className="btn btn-block btn-danger" disabled={!canSend} onClick={() => setMucking(true)}>
            {t('showdown.iLost')}
          </button>
        </div>
      )}
      {isHost ? (
        <button className="btn btn-gold btn-big btn-block" disabled={!ready || !canSend} onClick={() => send({ type: 'host:award', winners: sel })}>
          {ready ? t('showdown.award') : t('showdown.noWinner')}
        </button>
      ) : (
        <p className="muted small">{t('showdown.waitHost')}</p>
      )}
      {mucking && (
        <Confirm
          title={t('showdown.iLost')}
          message={t('showdown.muckConfirm')}
          danger
          onCancel={() => setMucking(false)}
          onConfirm={async () => {
            setMucking(false);
            await send({ type: 'muck' });
          }}
        />
      )}
    </div>
  );
}

/** Summary after a hand: winners, uncontested pots, eliminations, next hand. */
export function HandResultPanel() {
  const { room, isHost, send, canSend, name } = useGame();
  const { t, n } = useI18n();
  const g = room.game!;
  const hand = g.hand!;
  const result = hand.result;
  const won = new Map<number, number>();
  for (const p of result?.pots ?? []) for (const [s, a] of Object.entries(p.payouts)) won.set(Number(s), (won.get(Number(s)) ?? 0) + a);
  const busted = g.eliminations.filter((e) => e.hand === hand.number);
  return (
    <div className="panel">
      <div className="panel-title">{t('game.hand', { n: hand.number })}</div>
      {result?.uncontested && <p className="muted small">{t('result.uncontested')}</p>}
      <ul className="result-list">
        {[...won.entries()]
          .filter(([, a]) => a > 0)
          .map(([s, a]) => (
            <li key={s}>{t('result.wins', { name: name(s), amount: n(a) })}</li>
          ))}
        {busted.map((e) => (
          <li key={`b${e.seat}`} className="muted">
            {t('result.eliminated', { name: name(e.seat), place: e.place })}
          </li>
        ))}
      </ul>
      {isHost ? (
        <button className="btn btn-gold btn-big btn-block" disabled={!canSend || room.paused} onClick={() => send({ type: 'host:nextHand' })}>
          {t('result.nextHand')}
        </button>
      ) : (
        <p className="muted">{t('result.waitNext')}</p>
      )}
    </div>
  );
}

export function NoHandPanel() {
  const { isHost, send, canSend, room } = useGame();
  const { t } = useI18n();
  return (
    <div className="panel">
      {isHost ? (
        <button className="btn btn-gold btn-big btn-block" disabled={!canSend || room.paused} onClick={() => send({ type: 'host:nextHand' })}>
          {t('result.nextHand')}
        </button>
      ) : (
        <p className="muted">{t('result.waitNext')}</p>
      )}
    </div>
  );
}
