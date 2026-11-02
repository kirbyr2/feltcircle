// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Command } from '@feltcircle/game-protocol';
import type { CommandOutcome, SessionSnapshot } from '@feltcircle/game-session';
import { connectSeat, createOnlineRoom, disconnectSeat, joinSeat, toView, type RoomState } from '@feltcircle/room-core';
import { I18nProvider } from '../src/lib/i18n';
import { GameProvider } from '../src/components/game-context';
import { ringPosition } from '../src/components/SeatRing';
import { SeatPicker } from '../src/screens/Room';

const now = 1_000_000;

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

/** Minimal online session double: a fixed room snapshot and a controllable `join`. */
class FakeSession {
  listeners = new Set<() => void>();
  joins: Array<{ seat: number; nickname: string; takeover: boolean; resolve: (r: CommandOutcome) => void }> = [];
  constructor(public snapshot: SessionSnapshot) {}
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  send = (_cmd: Command) => Promise.resolve({ ok: true });
  dispose() {}
  join(seat: number, nickname: string, takeover = false): Promise<CommandOutcome> {
    return new Promise((resolve) => this.joins.push({ seat, nickname, takeover, resolve }));
  }
}

/** Waiting room with the host on seat 1 and Bea on seat 4 (6 seats). */
function room(edit?: (s: RoomState) => RoomState) {
  let s = createOnlineRoom({ id: 'RING1', hostToken: 'h', hostNickname: 'Ada', now, settings: { maxPlayers: 6 } });
  s = connectSeat(s, 1, now);
  s = joinSeat(s, 4, 'Bea', 'b', now);
  s = connectSeat(s, 4, now);
  return edit ? edit(s) : s;
}

function renderPicker(state: RoomState) {
  const session = new FakeSession({
    room: toView(state, null, now),
    mySeat: null,
    pendingSeat: null,
    isHost: false,
    local: false,
    connection: 'online',
    pending: false,
    lastError: null,
    gone: null,
  });
  render(
    <I18nProvider>
      <GameProvider session={session as never}>{(ctx) => (ctx ? <SeatPicker /> : null)}</GameProvider>
    </I18nProvider>,
  );
  return session;
}

describe('ringPosition', () => {
  it('puts seat 1 at the top and the rest clockwise, evenly spaced', () => {
    expect(ringPosition(0, 6)).toEqual({ x: 50, y: 10 });
    const right = ringPosition(1, 4);
    expect(right.x).toBeCloseTo(88);
    expect(right.y).toBeCloseTo(50);
    const bottom = ringPosition(2, 4);
    expect(bottom.x).toBeCloseTo(50);
    expect(bottom.y).toBeCloseTo(90);
    expect(ringPosition(3, 4).x).toBeCloseTo(12);
  });

  // Mirrors `.seat-ring` in styles.css: card 20% of the ring wide (60–96 px) and 70 px tall,
  // portrait ring 10:16 from 288 to 528 px wide, square ring 420–528 px on wide screens.
  it.each<[string, number, number]>([
    ['portrait', 16 / 10, 288],
    ['square', 1, 420],
  ])('seats never overlap or leave the ring (%s layout, 2–10 seats)', (_name, ratio, minW) => {
    for (let w = minW; w <= 528; w += 8) {
      const h = w * ratio;
      const cw = Math.min(96, Math.max(60, 0.2 * w));
      const ch = 70;
      for (let n = 2; n <= 10; n++) {
        const pts = Array.from({ length: n }, (_, i) => {
          const p = ringPosition(i, n);
          return { x: (p.x / 100) * w, y: (p.y / 100) * h };
        });
        for (const p of pts) {
          expect(p.x - cw / 2).toBeGreaterThanOrEqual(0);
          expect(p.x + cw / 2).toBeLessThanOrEqual(w);
          expect(p.y - ch / 2).toBeGreaterThanOrEqual(0);
          expect(p.y + ch / 2).toBeLessThanOrEqual(h);
        }
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) {
            const apart = Math.abs(pts[i].x - pts[j].x) >= cw + 2 || Math.abs(pts[i].y - pts[j].y) >= ch + 2;
            expect(apart, `w=${w} n=${n} seats ${i + 1}/${j + 1}`).toBe(true);
          }
      }
    }
  });
});

describe('circular seat picker', () => {
  it('shows every seat around the table, seat 1 first, with names, host and free seats', () => {
    renderPicker(room());
    const ring = screen.getByRole('group', { name: 'Seats around the table' });
    const slots = [...ring.querySelectorAll<HTMLElement>('.ring-slot')];
    expect(slots.map((s) => s.dataset.seat)).toEqual(['1', '2', '3', '4', '5', '6']);
    // Seat 1 is at the top centre.
    expect(slots[0].style.left).toBe('50%');
    expect(slots[0].style.top).toBe('10%');
    expect(slots[0].textContent).toContain('Ada');
    expect(slots[0].textContent).toContain('Host');
    expect(slots[3].textContent).toContain('Bea');
    for (const seat of [2, 3, 5, 6]) {
      const btn = screen.getByRole('button', { name: `Sit in seat ${seat}` });
      expect(btn.textContent).toContain('Sit here');
    }
    // Occupied, connected seats are not buttons.
    expect(screen.queryByRole('button', { name: /seat 1\b/ })).toBeNull();
    expect(screen.getByText(/renumbered without gaps/)).toBeTruthy();
  });

  it('joins once per tap, blocks duplicate submissions and shows a clear error', async () => {
    const session = renderPicker(room());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cy' } });
    const seat3 = screen.getByRole('button', { name: 'Sit in seat 3' });
    fireEvent.click(seat3);
    fireEvent.click(seat3);
    fireEvent.click(screen.getByRole('button', { name: 'Sit in seat 5' }));
    expect(session.joins.map((j) => [j.seat, j.nickname, j.takeover])).toEqual([[3, 'Cy', false]]);
    expect(seat3.textContent).toContain('Joining…');
    expect((screen.getByRole('button', { name: 'Sit in seat 5' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => session.joins[0].resolve({ ok: false, error: 'SEAT_TAKEN' }));
    expect(screen.getByRole('alert').textContent).toBe('That seat is taken.');
    expect((screen.getByRole('button', { name: 'Sit in seat 5' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sit in seat 5' }));
    expect(session.joins).toHaveLength(2);
  });

  it('offers to reclaim an offline seat (switching phones)', () => {
    const session = renderPicker(room((s) => disconnectSeat(s, 4, now)));
    const reclaim = screen.getByRole('button', { name: 'Take over seat 4 (Bea)' });
    expect(reclaim.textContent).toContain('Reclaim');
    fireEvent.click(reclaim);
    expect(session.joins.map((j) => [j.seat, j.takeover])).toEqual([[4, true]]);
  });

  it('disables seats while disconnected', () => {
    const session = renderPicker(room());
    act(() => {
      session.snapshot = { ...session.snapshot, connection: 'reconnecting' };
      for (const l of session.listeners) l();
    });
    expect((screen.getByRole('button', { name: 'Sit in seat 2' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves focus around the table with the arrow keys (clockwise)', () => {
    renderPicker(room());
    const seat2 = screen.getByRole('button', { name: 'Sit in seat 2' });
    seat2.focus();
    fireEvent.keyDown(seat2, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sit in seat 3' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sit in seat 5' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sit in seat 3' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sit in seat 6' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(seat2);
  });

  it('asks the host for a seat once the game has started', () => {
    renderPicker(room((s) => ({ ...s, status: 'playing' })));
    expect(screen.getByRole('button', { name: 'Ask the host for seat 2' }).textContent).toContain('Request');
  });
});
