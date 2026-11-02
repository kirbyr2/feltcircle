// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { SessionSnapshot } from '@feltcircle/game-session';
import { applyCommand, connectSeat, createOnlineRoom, joinSeat, requestSeat, toView, type RoomState } from '@feltcircle/room-core';
import { I18nProvider } from '../src/lib/i18n';
import { GameProvider } from '../src/components/game-context';
import { Table, tablePosition } from '../src/components/Table';

const now = 2_000_000;
afterEach(() => cleanup());

function ok(s: RoomState, seat: number, cmd: Parameters<typeof applyCommand>[2]) {
  const r = applyCommand(s, { seat }, cmd, now);
  if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  return r.state;
}

/** Waiting room 1 (Ada, host), 2 (Bo), 4 (Cy), 6 (Di) on a 6-seat table; started with Cy as dealer. */
function startedSparseRoom(): RoomState {
  let s = createOnlineRoom({ id: 'TBL01', hostToken: 'ta', hostNickname: 'Ada', now, settings: { maxPlayers: 6 } });
  s = connectSeat(s, 1, now);
  for (const [seat, nick] of [
    [2, 'Bo'],
    [4, 'Cy'],
    [6, 'Di'],
  ] as const) {
    s = joinSeat(s, seat, nick, `t${seat}`, now);
    s = connectSeat(s, seat, now);
  }
  return ok(s, 1, { type: 'host:start', dealerSeat: 4 });
}

function renderTable(state: RoomState, mySeat: number | null) {
  const snapshot: SessionSnapshot = {
    room: toView(state, mySeat, now),
    mySeat,
    pendingSeat: null,
    isHost: mySeat === state.hostSeat,
    local: false,
    connection: 'online',
    pending: false,
    lastError: null,
    gone: null,
  };
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {}, send: async () => ({ ok: true }), dispose() {} };
  const { container } = render(
    <I18nProvider>
      <GameProvider session={session}>{(ctx) => (ctx ? <Table /> : null)}</GameProvider>
    </I18nProvider>,
  );
  return [...container.querySelectorAll<HTMLElement>('.table-wrap .seat')].map((el) => ({
    el,
    seat: el.querySelector('.seat-no')!.textContent,
    name: el.querySelector('.seat-name')!.textContent,
    x: parseFloat(el.style.left),
    y: parseFloat(el.style.top),
  }));
}

describe('tablePosition', () => {
  it('spaces the occupied seats evenly with the anchor at the bottom, clockwise', () => {
    // 4 players: bottom, left, top, right (clockwise on screen).
    const pts = [0, 1, 2, 3].map((i) => tablePosition(i, 4, 0));
    expect(pts[0].x).toBeCloseTo(50);
    expect(pts[0].y).toBeCloseTo(92);
    expect(pts[1].x).toBeCloseTo(6);
    expect(pts[1].y).toBeCloseTo(50);
    expect(pts[2].x).toBeCloseTo(50);
    expect(pts[2].y).toBeCloseTo(8);
    expect(pts[3].x).toBeCloseTo(94);
    // Rotating the anchor keeps the same evenly spaced positions.
    expect(tablePosition(2, 4, 2)).toEqual(tablePosition(0, 4, 0));
  });
});

describe('active table after the start', () => {
  it('shows only the four seated players, evenly spaced, with the viewer at the bottom', () => {
    const state = startedSparseRoom();
    expect(state.settings.maxPlayers).toBe(6); // capacity is kept for late joins
    // Cy sat on waiting-room seat 4 and plays as seat 3.
    const seats = renderTable(state, 3);
    expect(seats.map((s) => [s.seat, s.name])).toEqual([
      ['1', 'Ada'],
      ['2', 'Bo'],
      ['3', 'Cy'],
      ['4', 'Di'],
    ]);
    const at = (seat: string) => seats.find((s) => s.seat === seat)!;
    // Four positions (bottom, left, top, right), not four players on a six-position table.
    expect(at('3').x).toBeCloseTo(50);
    expect(at('3').y).toBeCloseTo(92);
    expect(at('4').x).toBeCloseTo(6);
    expect(at('1').y).toBeCloseTo(8);
    expect(at('2').x).toBeCloseTo(94);
    expect(at('3').el.classList.contains('seat-me')).toBe(true);
    // Dealer (chosen in the waiting room), blinds, turn and host indicators follow the new numbers.
    expect(at('4').el.querySelector('.marker-sb')).not.toBeNull();
    expect(at('1').el.querySelector('.marker-bb')).not.toBeNull();
    expect(at('1').el.querySelector('.tag-host')).not.toBeNull();
    expect(at('3').el.querySelector('.marker-d')).not.toBeNull();
    expect(at('2').el.classList.contains('seat-active')).toBe(true);
    // Stacks after the blinds: SB 10, BB 20.
    expect(at('4').el.querySelector('.seat-stack')!.textContent).toBe('1,990');
    expect(at('1').el.querySelector('.seat-stack')!.textContent).toBe('1,980');
  });

  it('adds a late joiner as a fifth evenly spaced position without renumbering anyone', () => {
    let state = startedSparseRoom();
    state = requestSeat(state, 6, 'Eli', 'te', now);
    state = ok(state, 1, { type: 'host:approveJoin', seat: 6, chips: 2000 });
    const seats = renderTable(state, 1);
    expect(seats.map((s) => [s.seat, s.name])).toEqual([
      ['1', 'Ada'],
      ['2', 'Bo'],
      ['3', 'Cy'],
      ['4', 'Di'],
      ['6', 'Eli'],
    ]);
    // Seated for the next hand with the chips the host chose, not shown as busted.
    expect(seats[4].el.querySelector('.seat-stack')!.textContent).toBe('2,000');
    expect(seats[4].el.classList.contains('seat-out')).toBe(false);
    // Viewer (seat 1) at the bottom; five positions 72° apart.
    const first = seats[0];
    expect(first.x).toBeCloseTo(50);
    expect(first.y).toBeCloseTo(92);
    for (let i = 0; i < 5; i++) {
      const p = tablePosition(i, 5, 0);
      expect(seats[i].x).toBeCloseTo(p.x);
      expect(seats[i].y).toBeCloseTo(p.y);
    }
  });

  it('Local Mode (no viewer) puts seat 1 at the bottom', () => {
    const seats = renderTable(startedSparseRoom(), null);
    expect(seats[0].seat).toBe('1');
    expect(seats[0].y).toBeCloseTo(92);
  });
});
