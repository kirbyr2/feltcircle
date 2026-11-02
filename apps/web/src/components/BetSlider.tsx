import { useEffect, useState } from 'react';
import type { LegalActions } from '@feltcircle/poker-engine';
import { useI18n } from '../lib/i18n';

interface Props {
  legal: LegalActions;
  bigBlind: number;
  disabled: boolean;
  /** Initial amount (defaults to the minimum). */
  initial?: number;
  onConfirm: (amount: number) => void;
  onCancel: () => void;
}

/**
 * Chooses the total bet / raise-to for this street. Dragging never acts:
 * only the confirm button submits. Limits come from the shared engine.
 */
export function BetSlider({ legal, bigBlind, disabled, initial, onConfirm, onCancel }: Props) {
  const { t, n } = useI18n();
  const { minTo, maxTo, tableBet, currentBet, potTotal, callAmount } = legal;
  const start = initial ?? minTo;
  const [amount, setAmount] = useState(start);
  const [text, setText] = useState(String(start));
  useEffect(() => {
    setAmount(start);
    setText(String(start));
  }, [start, minTo, maxTo]);

  const clamp = (v: number) => Math.max(minTo, Math.min(maxTo, Math.round(v)));
  const set = (v: number) => {
    const c = clamp(v);
    setAmount(c);
    setText(String(c));
  };
  // Pot-sized raise: call first, then raise by the resulting pot.
  const potAfterCall = potTotal + callAmount;
  const quick = [
    { key: 'min', label: t('action.min'), value: minTo },
    { key: 'half', label: t('action.halfPot'), value: tableBet + Math.floor(potAfterCall / 2) },
    { key: 'pot', label: t('action.pot'), value: tableBet + potAfterCall },
    { key: 'all', label: t('action.allIn'), value: maxTo },
  ];
  const typed = Number(text);
  const typedValid = text !== '' && Number.isInteger(typed) && typed >= minTo && typed <= maxTo;
  const value = typedValid ? typed : amount;
  const isAllIn = value === maxTo;
  const short = isAllIn && maxTo < legal.fullMinTo;
  const step = Math.max(1, Math.min(bigBlind / 2, Math.floor((maxTo - minTo) / 100) || 1));
  const label = legal.aggressive === 'bet' ? t('action.betTo', { amount: n(value) }) : t('action.raiseTo', { amount: n(value) });

  return (
    <div className="slider-panel">
      <div className="slider-amount">
        <input
          className="amount-input"
          aria-label={t('action.amount')}
          inputMode="numeric"
          value={text}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9]/g, '');
            setText(v);
            const num = Number(v);
            if (v && num >= minTo && num <= maxTo) setAmount(num);
          }}
          onBlur={() => set(typedValid ? typed : amount)}
        />
        <span className="muted">{t('action.adds', { amount: n(value - currentBet) })}</span>
        {short && <span className="tag tag-allin">{t('action.shortAllIn')}</span>}
      </div>
      <input
        type="range"
        className="range"
        min={minTo}
        max={maxTo}
        step={step}
        value={value}
        onChange={(e) => {
          // Snap to the step but always allow exact min and max.
          const v = Number(e.target.value);
          set(v >= maxTo - step / 2 ? maxTo : v);
        }}
        aria-label={t('action.amount')}
      />
      <div className="quick-row">
        {quick.map((q) => (
          <button key={q.key} className="btn btn-small" onClick={() => set(q.value)} disabled={clamp(q.value) === value && q.key !== 'min'}>
            {q.label}
          </button>
        ))}
      </div>
      <div className="row gap">
        <button className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-gold btn-big" disabled={disabled || !(value >= minTo && value <= maxTo)} onClick={() => onConfirm(value)}>
          {isAllIn ? `${t('action.allIn')} ${n(value)}` : label}
        </button>
      </div>
    </div>
  );
}
