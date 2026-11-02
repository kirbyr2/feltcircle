// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Command } from '@feltcircle/game-protocol';
import type { SessionSnapshot } from '@feltcircle/game-session';
import { applyCommand, connectSeat, createOnlineRoom, joinSeat, toView, type RoomState } from '@feltcircle/room-core';
import { I18nProvider } from '../src/lib/i18n';
import { GameProvider, useGame } from '../src/components/game-context';
import { RevealPanel, ShowdownPanel, WaitingPanel } from '../src/components/Panels';
import { ActionPanel } from '../src/components/ActionPanel';

const now = 7_000_000;
afterEach(() => cleanup());

function ok(s: RoomState, seat: number, cmd: Command) {
  const r = applyCommand(s, { seat }, cmd, now);
  if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  return r.state;
}
const call: Command = { type: 'act', action: { type: 'call' } };
const check: Command = { type: 'act', action: { type: 'check' } };

/** Dealer 1 (Ada, host), SB 2, BB 3; seat 1 acts first. */
function started(): RoomState {
  let s = createOnlineRoom({ id: 'SDUI1', hostToken: 't1', hostNickname: 'Ada', now, settings: { maxPlayers: 6 } });
  s = connectSeat(s, 1, now);
  for (const seat of [2, 3]) s = connectSeat(joinSeat(s, seat, `P${seat}`, `t${seat}`, now), seat, now);
  return ok(s, 1, { type: 'host:start' });
}
const flop = () => ok(ok(ok(started(), 1, call), 2, call), 3, check);
function river(): RoomState {
  let s = flop();
  for (let i = 0; i < 9; i++) s = ok(s, [2, 3, 1][i % 3], check);
  return s;
}
const showdown = () => ok(river(), 1, { type: 'host:showdown' });

/** The panel GameScreen shows for the viewer in the current phase. */
function Screen() {
  const { room, mySeat } = useGame();
  const hand = room.game!.hand!;
  if (hand.phase === 'reveal') return <RevealPanel />;
  if (hand.phase === 'showdown') return <ShowdownPanel />;
  return hand.toAct === mySeat ? <ActionPanel seat={mySeat!} /> : <WaitingPanel />;
}

function mount(state: RoomState, seat: number) {
  const sent: Command[] = [];
  const listeners = new Set<() => void>();
  let s = state;
  let snapshot: SessionSnapshot;
  const refresh = () => {
    snapshot = { room: toView(s, seat, now), mySeat: seat, pendingSeat: null, isHost: seat === s.hostSeat, local: false, connection: 'online', pending: false, lastError: null, gone: null };
  };
  refresh();
  const notify = () => {
    refresh();
    for (const l of listeners) l();
  };
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
        notify();
      }
      return { ok: r.ok, error: r.error };
    },
    dispose() {},
  };
  const other = (by: number, cmd: Command) =>
    act(() => {
      s = ok(s, by, cmd);
      notify();
    });
  render(
    <I18nProvider>
      <GameProvider session={session as never}>{(ctx) => (ctx ? <Screen /> : null)}</GameProvider>
    </I18nProvider>,
  );
  return { sent, other, state: () => s };
}

const btn = (name: string) => screen.getByRole('button', { name });
const text = () => document.body.textContent ?? '';

describe('dealing instructions (no Deal buttons)', () => {
  it('the first player of the flop is told to deal it, then act', () => {
    mount(flop(), 2);
    expect(screen.getByRole('status').textContent).toBe('Deal the flop, then it’s your turn.');
    expect(screen.queryByRole('button', { name: /deal/i })).toBeNull();
    expect(btn('Check')).toBeTruthy();
  });

  it('everyone else is told to deal, then wait for that player', () => {
    mount(flop(), 1);
    expect(document.querySelector('.panel-title')!.textContent).toBe('Deal the flop, then wait for P2 to act.');
  });

  it('once someone has acted on the street, nobody is asked to deal it again', () => {
    mount(ok(flop(), 2, check), 3);
    expect(text()).not.toContain('Deal the flop');
  });
});

describe('reveal and the single showdown confirmation', () => {
  it('after river betting: reveal hands; the host begins the showdown', async () => {
    const { sent, state } = mount(river(), 1);
    expect(screen.getByRole('status').textContent).toBe('Reveal your hands.');
    await act(async () => fireEvent.click(btn('All cards dealt and hands revealed — begin showdown')));
    expect(sent).toEqual([{ type: 'host:showdown' }]);
    expect(state().game!.hand!.phase).toBe('showdown');
  });

  it('all-in before the river: deal the rest first; guests wait for the host', () => {
    let s = ok(started(), 1, { type: 'act', action: { type: 'allin' } });
    s = ok(ok(s, 2, call), 3, call);
    mount(s, 2);
    expect(screen.getByRole('status').textContent).toBe('Deal the remaining community cards, then reveal your hands.');
    expect(screen.queryByRole('button', { name: /begin showdown/ })).toBeNull();
    expect(text()).toContain('The host begins the showdown');
  });
});

describe('showdown declarations', () => {
  it('Win, Tie and Fold for a contender; Win is sent with the hand number', async () => {
    const { sent } = mount(showdown(), 3);
    const group = screen.getByRole('group', { name: 'Your showdown declaration' });
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Win', 'Tie', 'Fold']);
    await act(async () => fireEvent.click(btn('Win')));
    expect(sent).toEqual([{ type: 'declare', declaration: 'win', hand: 1 }]);
    expect(btn('Win').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('P3 selected Win. Others fold automatically in 5s unless they select Win or Tie.');
    // The claimant has no countdown on their own Fold button.
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('others see the countdown on their Fold button; Fold then applies at once', async () => {
    const { other, sent, state } = mount(showdown(), 2);
    other(3, { type: 'declare', declaration: 'win' });
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('Fold automatically in 5s unless you select Win or Tie.');
    const fold = screen.getByRole('button', { name: /^Fold/ });
    expect(fold.getAttribute('aria-describedby')).toBe(timer.id);
    expect(fold.textContent).toBe('Fold5s');
    await act(async () => fireEvent.click(fold));
    expect(sent).toEqual([{ type: 'declare', declaration: 'fold', hand: 1 }]);
    expect(state().game!.hand!.seats.find((x) => x.seat === 2)!.mucked).toBe(true);
  });

  it('without a countdown Fold asks for confirmation first', async () => {
    const { sent } = mount(showdown(), 2);
    await act(async () => fireEvent.click(btn('Fold')));
    expect(sent).toEqual([]);
    expect(text()).toContain('Your chips stay in the pot.');
  });

  it('a conflict shows host judgment to everyone and removes the countdown', () => {
    const { other } = mount(showdown(), 2);
    other(3, { type: 'declare', declaration: 'win' });
    other(1, { type: 'declare', declaration: 'tie' });
    expect(screen.getByRole('status').textContent).toBe('Host judgment required.');
    expect(screen.queryByRole('timer')).toBeNull();
    expect(text()).toContain('Waiting for the host to select winners');
    // Declarations are visible on the pot list.
    expect([...document.querySelectorAll('.claim-badge')].map((b) => b.textContent)).toEqual(['Tie', 'Win']);
  });

  it('players who folded during betting get no declaration buttons', () => {
    let s = ok(started(), 1, call);
    s = ok(ok(s, 2, { type: 'act', action: { type: 'fold' } }), 3, check);
    for (let i = 0; i < 6; i++) s = ok(s, [3, 1][i % 2], check);
    s = ok(s, 1, { type: 'host:showdown' });
    mount(s, 2);
    expect(screen.queryByRole('group', { name: 'Your showdown declaration' })).toBeNull();
  });

  it('the host can still settle while a countdown runs', async () => {
    const { other, sent } = mount(showdown(), 1);
    other(3, { type: 'declare', declaration: 'win' });
    // The sole Win is preselected for the host.
    await act(async () => fireEvent.click(btn('Award pots')));
    expect(sent.at(-1)).toEqual({ type: 'host:award', winners: [[3]] });
  });
});
