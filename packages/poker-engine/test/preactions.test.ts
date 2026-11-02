import { describe, expect, it } from 'vitest';
import { legalActions, owedForPreAction, preActionChoices, resolvePreAction } from '../src/index.js';
import { begin, call, fold, play, raise } from './helpers.js';

// Three players: dealer 1, SB 2, BB 3; seat 1 acts first pre-flop.
const start = () => begin({ 1: 1000, 2: 1000, 3: 1000 }, { firstDealer: 1 });

describe('pre-action eligibility (amount actually owed)', () => {
  it('the big blind owes nothing pre-flop until someone raises; calls alone do not change that', () => {
    let t = start();
    expect(owedForPreAction(t.hand!, 3)).toBe(0);
    expect(preActionChoices(t.hand!, 3)).toEqual(['checkfold', 'check', 'callany']);
    // The small blind owes 10: Fold is offered, Check is not.
    expect(owedForPreAction(t.hand!, 2)).toBe(10);
    expect(preActionChoices(t.hand!, 2)).toEqual(['fold', 'checkfold', 'callany']);
    t = play(t, [[1, call]]);
    expect(owedForPreAction(t.hand!, 3)).toBe(0);
    t = play(t, [[2, raise(60)]]);
    expect(owedForPreAction(t.hand!, 3)).toBe(40);
    expect(preActionChoices(t.hand!, 3)).toEqual(['fold', 'checkfold', 'callany']);
  });

  it('a new street starts with nothing owed; folded players are offered nothing', () => {
    let t = play(start(), [
      [1, call],
      [2, call],
    ]);
    t = play(t, [[3, { type: 'check' }]]);
    expect(t.hand!.street).toBe('flop');
    expect(preActionChoices(t.hand!, 3)).toEqual(['checkfold', 'check', 'callany']);
    t = play(t, [[2, fold]]);
    expect(preActionChoices(t.hand!, 2)).toEqual([]);
    expect(owedForPreAction(t.hand!, 2)).toBe(null);
    expect(owedForPreAction(t.hand!, 9)).toBe(null);
  });
});

describe('resolvePreAction', () => {
  const legalFor = (owed: boolean) => {
    const t = owed ? play(start(), [[1, raise(80)]]) : play(start(), [[1, call], [2, call]]);
    const seat = owed ? 2 : 3;
    return legalActions(t.hand!, seat)!;
  };

  it('checking legal: all three check', () => {
    const legal = legalFor(false);
    expect(legal.canCheck).toBe(true);
    expect(resolvePreAction('checkfold', legal)).toEqual({ type: 'check' });
    expect(resolvePreAction('check', legal)).toEqual({ type: 'check' });
    expect(resolvePreAction('callany', legal)).toEqual({ type: 'check' });
  });

  it('chips required: Check/Fold folds, Check cancels (never folds or calls), Call Any calls', () => {
    const legal = legalFor(true);
    expect(legal.canCheck).toBe(false);
    expect(resolvePreAction('checkfold', legal)).toEqual({ type: 'fold' });
    expect(resolvePreAction('check', legal)).toBe('cancel');
    expect(resolvePreAction('callany', legal)).toEqual({ type: 'call' });
    expect(resolvePreAction('fold', legal)).toEqual({ type: 'fold' });
  });
});
