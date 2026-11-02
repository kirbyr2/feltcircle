// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Command } from '@feltcircle/game-protocol';
import type { SessionSnapshot } from '@feltcircle/game-session';
import { applyCommand, connectSeat, createOnlineRoom, joinSeat, toView, type RoomState } from '@feltcircle/room-core';
import { I18nProvider } from '../src/lib/i18n';
import { GameProvider } from '../src/components/game-context';
import { PreActions } from '../src/components/Panels';
import { ActionPanel } from '../src/components/ActionPanel';

const now = 5_000_000;
afterEach(() => cleanup());

function ok(s: RoomState, seat: number, cmd: Command) {
  const r = applyCommand(s, { seat }, cmd, now);
  if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  return r.state;
}

/** Dealer 1, SB 2, BB 3 (the big blind owes nothing until someone raises); seat 1 to act. */
function started(): RoomState {
  let s = createOnlineRoom({ id: 'PREUI', hostToken: 't1', hostNickname: 'Ada', now, settings: { maxPlayers: 6 } });
  s = connectSeat(s, 1, now);
  for (const seat of [2, 3]) s = connectSeat(joinSeat(s, seat, `P${seat}`, `t${seat}`, now), seat, now);
  return ok(s, 1, { type: 'host:start' });
}

/** Session double backed by the real room state machine, so the UI sees authoritative results. */
function mount(state: RoomState, seat: number, panel: 'pre' | 'action' = 'pre') {
  const sent: Command[] = [];
  const listeners = new Set<() => void>();
  let s = state;
  let snapshot: SessionSnapshot;
  const refresh = () => {
    snapshot = {
      room: toView(s, seat, now),
      mySeat: seat,
      pendingSeat: null,
      isHost: seat === s.hostSeat,
      local: false,
      connection: 'online',
      pending: false,
      lastError: null,
      gone: null,
    };
  };
  refresh();
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    send: async (cmd: Command) => {
      sent.push(cmd);
      const r = applyCommand(s, { seat }, cmd, now);
      if (r.ok) {
        s = r.state;
        refresh();
        for (const l of listeners) l();
      }
      return { ok: r.ok, error: r.error };
    },
    dispose() {},
  };
  const other = (by: number, cmd: Command) =>
    act(() => {
      s = ok(s, by, cmd);
      refresh();
      for (const l of listeners) l();
    });
  render(
    <I18nProvider>
      <GameProvider session={session as never}>{(ctx) => (ctx ? panel === 'pre' ? <PreActions seat={seat} /> : <ActionPanel seat={seat} /> : null)}</GameProvider>
    </I18nProvider>,
  );
  return { sent, other, state: () => s };
}

const options = () => [...document.querySelectorAll<HTMLButtonElement>('.pre-row button')].map((b) => b.textContent);
const btn = (name: string) => screen.getByRole('button', { name });

describe('pre-action panel', () => {
  it('checking legal: Check/Fold, Check and Call Any; no standalone Fold; Call Any is explained', () => {
    mount(started(), 3);
    expect(options()).toEqual(['Check / Fold', 'Check', 'Call Any']);
    expect(screen.queryByRole('button', { name: /^Fold$/ })).toBeNull();
    const callAny = btn('Call Any');
    const hint = document.getElementById(callAny.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toContain('all your remaining chips');
    // Visible as well, before anything is selected.
    expect(document.querySelector('.pre-hint')!.textContent).toContain('all your remaining chips');
  });

  it('chips owed: Fold, Check/Fold and Call Any (existing behaviour)', () => {
    mount(started(), 2);
    expect(options()).toEqual(['Fold', 'Check / Fold', 'Call Any']);
  });

  it('selects, switches and cancels with the hand number attached', async () => {
    const { sent, state } = mount(started(), 3);
    await act(async () => fireEvent.click(btn('Check')));
    expect(btn('Check').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.pre-hint')!.textContent).toBe('Checks if nobody bets. If someone bets, you choose.');
    await act(async () => fireEvent.click(btn('Call Any')));
    expect(btn('Call Any').getAttribute('aria-pressed')).toBe('true');
    expect(btn('Check').getAttribute('aria-pressed')).toBe('false');
    await act(async () => fireEvent.click(btn('Call Any')));
    expect(sent).toEqual([
      { type: 'setPreAction', preAction: 'check', hand: 1 },
      { type: 'setPreAction', preAction: 'callany', hand: 1 },
      { type: 'setPreAction', preAction: null, hand: 1 },
    ]);
    expect(state().preActions).toEqual({});
  });

  it('a raise cancels Check, shows the notice and offers the facing-a-bet options', async () => {
    const { other } = mount(started(), 3);
    await act(async () => fireEvent.click(btn('Check')));
    other(1, { type: 'act', action: { type: 'raise', amount: 60 } });
    expect(screen.getByRole('status').textContent).toBe('Auto-check canceled. Choose your action.');
    expect(options()).toEqual(['Fold', 'Check / Fold', 'Call Any']);
    expect(document.querySelectorAll('.pre-row [aria-pressed="true"]')).toHaveLength(0);
  });

  it('the notice is also shown on the action panel when the turn arrives', () => {
    let s = ok(started(), 3, { type: 'setPreAction', preAction: 'check' });
    s = ok(s, 1, { type: 'act', action: { type: 'raise', amount: 60 } });
    s = ok(s, 2, { type: 'act', action: { type: 'call' } });
    mount(s, 3, 'action');
    expect(screen.getByRole('status').textContent).toBe('Auto-check canceled. Choose your action.');
    // Normal manual actions, Fold included, are still there.
    expect(screen.getByRole('button', { name: 'Fold' })).toBeTruthy();
  });
});
