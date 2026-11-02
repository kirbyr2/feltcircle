import { useCallback, useEffect, useMemo, useState } from 'react';
import { Confirm } from './ui';
import type { PreAction } from '@feltcircle/game-protocol';
import { preActionChoices, streetToDeal, type HandState } from '@feltcircle/poker-engine';
import { useI18n } from '../lib/i18n';
import { useGame } from './game-context';

/** Shown after the server cancelled the player's Check because a call became necessary. */
export function PreActionNotice() {
  const { room } = useGame();
  const { t } = useI18n();
  if (room.preActionNotice !== 'checkCanceled') return null;
  return (
    <div className="pre-notice" role="status">
      {t('pre.checkCanceled')}
    </div>
  );
}

/**
 * Optional pre-actions while waiting (online). Selecting never bets
 * immediately. The options come from the amount actually owed (shared engine
 * rules): with nothing owed Check/Fold, Check and Call Any (no standalone
 * Fold); when chips are owed Fold, Check/Fold and Call Any. The server checks
 * every selection against the authoritative hand.
 */
export function PreActions({ seat }: { seat: number }) {
  const { room, send, canSend, name } = useGame();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const hand = room.game!.hand!;
  const choices = preActionChoices(hand, seat);
  if (choices.length === 0) return null;
  const current = room.myPreAction && choices.includes(room.myPreAction) ? room.myPreAction : null;
  const label: Record<PreAction, string> = {
    fold: t('pre.fold'),
    checkfold: t('pre.checkfold'),
    check: t('pre.check'),
    callany: t('pre.callany'),
  };
  const hintFor: PreAction | null = current ?? (choices.includes('callany') ? 'callany' : null);
  const hintId = `pre-hint-${seat}`;
  const callanyId = `pre-callany-${seat}`;
  const choose = async (v: PreAction) => {
    if (busy) return;
    setBusy(true);
    // Tapping the selected option cancels it; any other option replaces it.
    // `hand` makes the server ignore a selection that arrives after this hand.
    await send({ type: 'setPreAction', preAction: current === v ? null : v, hand: hand.number });
    setBusy(false);
  };
  return (
    <div className="panel">
      <div className="panel-title">{waitingTitle(hand, name, t)}</div>
      <PreActionNotice />
      <div className="pre-row" role="group" aria-label={t('pre.title')}>
        {choices.map((v) => (
          <button
            key={v}
            className={`btn btn-pre ${current === v ? 'on' : ''}`}
            aria-pressed={current === v}
            aria-describedby={v === 'callany' ? callanyId : undefined}
            disabled={!canSend || busy}
            data-pre={v}
            onClick={() => void choose(v)}
          >
            <span className="check-box" aria-hidden="true">
              {current === v ? '✓' : ''}
            </span>
            {label[v]}
          </button>
        ))}
      </div>
      {hintFor && (
        <p className="pre-hint" id={hintId} aria-live="polite">
          {t(`pre.hint.${hintFor}`)}
        </p>
      )}
      {choices.includes('callany') && (
        <span className="sr-only" id={callanyId}>
          {t('pre.hint.callany')}
        </span>
      )}
    </div>
  );
}

/**
 * Title for players waiting on someone else. At the start of the flop, turn
 * and river it also tells the table to deal those cards first.
 */
function waitingTitle(hand: HandState, name: (seat: number) => string, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (hand.toAct === null) return t('common.loading');
  const deal = streetToDeal(hand);
  return deal ? t(`deal.${deal}Wait`, { name: name(hand.toAct) }) : t('game.toAct', { name: name(hand.toAct) });
}

export function WaitingPanel() {
  const { room, name } = useGame();
  const { t } = useI18n();
  const hand = room.game?.hand;
  return (
    <div className="panel">
      <div className="panel-title">{hand ? waitingTitle(hand, name, t) : t('common.loading')}</div>
    </div>
  );
}

/**
 * No more betting: deal whatever is left of the board and reveal the hands.
 * The host's one confirmation opens the showdown (declarations, settlement).
 */
export function RevealPanel() {
  const { room, isHost, send, canSend } = useGame();
  const { t } = useI18n();
  const hand = room.game!.hand!;
  // Betting ended on the river: the board is complete. Otherwise cards are still to come.
  const msg = hand.street === 'river' ? t('reveal.reveal') : t('reveal.runout');
  return (
    <div className="panel">
      <p className="lead" role="status">
        {msg}
      </p>
      {isHost ? (
        <button className="btn btn-gold btn-big btn-block" disabled={!canSend} onClick={() => send({ type: 'host:showdown' })}>
          {t('reveal.begin')}
        </button>
      ) : (
        <p className="muted small">{t('reveal.waitHost')}</p>
      )}
    </div>
  );
}

/** Whole seconds left until a server deadline; the server decides, this is only a display. */
export function useServerCountdown(deadline: number | null, serverTime: number): number | null {
  // Offset between the server clock and this device, measured when the state arrived.
  const offset = useMemo(() => serverTime - Date.now(), [serverTime]);
  const [, force] = useState(0);
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(id);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - (Date.now() + offset)) / 1000));
}

/**
 * Showdown. Every player still contesting a pot (all-in players included)
 * declares Win, Tie or Fold (Fold gives up the pot; chips stay in it). With a
 * single pot, one Win and nothing else, the others fold automatically after a
 * short countdown unless they select Win or Tie; any conflict hands the
 * decision to the host for the rest of the showdown. The host can always
 * settle each pot (ties split by the engine).
 */
export function ShowdownPanel() {
  const { room, isHost, local, mySeat, send, canSend, name } = useGame();
  const { t, n } = useI18n();
  const [folding, setFolding] = useState<number | null>(null);
  const hand = room.game!.hand!;
  const pots = room.pots;
  const sd = room.showdown;
  const decl = useMemo(() => sd?.declarations ?? {}, [sd]);
  const contenders = useMemo(() => [...new Set(pots.flatMap((p) => p.eligible))].sort((a, b) => a - b), [pots]);
  const seconds = useServerCountdown(sd?.deadline ?? null, room.serverTime);
  const counting = sd?.deadline != null && sd.claimant !== null;

  const suggestion = useCallback(
    () =>
      pots.map((p) => {
        if (p.eligible.length === 1) return [...p.eligible];
        const wins = p.eligible.filter((s) => decl[s] === 'win');
        if (wins.length === 1) return wins;
        const ties = p.eligible.filter((s) => decl[s] === 'tie');
        return wins.length === 0 && ties.length > 1 ? ties : [];
      }),
    [pots, decl],
  );
  const key = JSON.stringify([pots, decl]);
  const [sel, setSel] = useState<number[][]>(suggestion);
  useEffect(() => setSel(suggestion()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = useMemo(() => sel.length === pots.length && sel.every((s) => s.length > 0), [sel, pots.length]);
  const potName = (i: number) => (i === 0 ? t('game.mainPot') : t('game.sidePot', { n: i }));

  const declare = (seat: number, declaration: 'win' | 'tie' | 'fold' | null) =>
    send({ type: 'declare', declaration, hand: hand.number, ...(local ? { seat } : {}) });

  const status = counting
    ? t('showdown.countdown', { name: name(sd!.claimant!), seconds: seconds ?? 0 })
    : sd?.manual
      ? sd.sidePots
        ? t('showdown.sidePots')
        : t('showdown.manual')
      : t('showdown.declare');

  const badge = (seat: number) =>
    decl[seat] ? <span className={`claim-badge decl-${decl[seat]}`}>{decl[seat] === 'win' ? t('showdown.win') : t('showdown.tie')}</span> : null;

  /** Win / Tie / Fold for one seat (the viewer online; any contender in Local Mode). */
  const choices = (seat: number) => {
    const cur = decl[seat] ?? null;
    const mine = counting && sd!.claimant !== seat;
    const timerId = `decl-timer-${seat}`;
    return (
      <div key={seat} className="decl-block">
        {local && (
          <div className="decl-name">
            <span className="seat-no">{seat}</span> {name(seat)}
          </div>
        )}
        <div className="decl-row" role="group" aria-label={local ? t('showdown.choiceFor', { name: name(seat) }) : t('showdown.yourChoice')}>
          <button className={`btn btn-decl ${cur === 'win' ? 'on' : ''}`} aria-pressed={cur === 'win'} disabled={!canSend} onClick={() => void declare(seat, cur === 'win' ? null : 'win')}>
            {t('showdown.win')}
          </button>
          <button className={`btn btn-decl ${cur === 'tie' ? 'on' : ''}`} aria-pressed={cur === 'tie'} disabled={!canSend} onClick={() => void declare(seat, cur === 'tie' ? null : 'tie')}>
            {t('showdown.tie')}
          </button>
          <button
            className={`btn btn-decl btn-danger ${mine ? 'counting' : ''}`}
            disabled={!canSend}
            aria-describedby={mine ? timerId : undefined}
            // While the countdown runs Fold applies at once (it would happen anyway); otherwise confirm first.
            onClick={() => (mine ? void declare(seat, 'fold') : setFolding(seat))}
          >
            {t('showdown.fold')}
            {mine && seconds !== null && (
              <span className="decl-count" aria-hidden="true">
                {seconds}s
              </span>
            )}
          </button>
        </div>
        {mine && (
          <p className="decl-warn" id={timerId} role="timer">
            {t('showdown.autoFoldIn', { seconds: seconds ?? 0 })}
          </p>
        )}
      </div>
    );
  };

  const myControls = !local && mySeat !== null && contenders.includes(mySeat);
  return (
    <div className="panel">
      <div className="panel-title">{t('showdown.title')}</div>
      <p className={`showdown-status ${sd?.manual ? 'manual' : ''}`} role="status">
        {status}
      </p>
      {pots.map((p, i) => (
        <div key={i} className="pot-select">
          <div className="pot-select-head">
            <span>{potName(i)}</span>
            <b>{n(p.amount)}</b>
          </div>
          <div className="chip-row">
            {p.eligible.map((seat) =>
              isHost ? (
                <button
                  key={seat}
                  className={`chip-btn ${sel[i]?.includes(seat) ? 'on' : ''}`}
                  aria-pressed={sel[i]?.includes(seat)}
                  onClick={() =>
                    setSel((cur) => {
                      const next = cur.map((x) => [...x]);
                      const has = next[i].includes(seat);
                      next[i] = has ? next[i].filter((s) => s !== seat) : [...next[i], seat].sort((a, b) => a - b);
                      // Convenience: a winner of a larger pot also preselects smaller side pots they are eligible for.
                      if (!has) for (let j = i + 1; j < pots.length; j++) if (next[j].length === 0 && pots[j].eligible.includes(seat)) next[j] = [seat];
                      return next;
                    })
                  }
                >
                  <span className="seat-no">{seat}</span> {name(seat)} {badge(seat)}
                </button>
              ) : (
                <span key={seat} className={`chip-btn static ${decl[seat] ? 'on' : ''}`}>
                  <span className="seat-no">{seat}</span> {name(seat)} {badge(seat)}
                </span>
              ),
            )}
          </div>
        </div>
      ))}
      {myControls && choices(mySeat!)}
      {local && <div className="decl-list">{contenders.map((seat) => choices(seat))}</div>}
      {isHost ? (
        <>
          <p className="muted small">{`${t('showdown.select')} ${t('showdown.tieHint')}`}</p>
          <button className="btn btn-gold btn-big btn-block" disabled={!ready || !canSend} onClick={() => send({ type: 'host:award', winners: sel })}>
            {ready ? t('showdown.award') : t('showdown.noWinner')}
          </button>
        </>
      ) : (
        sd?.manual && <p className="muted small">{t('showdown.waitHost')}</p>
      )}
      {folding !== null && (
        <Confirm
          title={t('showdown.fold')}
          message={t('showdown.foldConfirm')}
          danger
          onCancel={() => setFolding(null)}
          onConfirm={async () => {
            const seat = folding;
            setFolding(null);
            await declare(seat, 'fold');
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
