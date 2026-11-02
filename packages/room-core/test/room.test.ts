import { describe, expect, it } from 'vitest';
import { AUTO_FOLD_AFTER_MS, ROOM_TTL_MS, type Command } from '@feltcircle/game-protocol';
import { totalChips } from '@feltcircle/poker-engine';
import { encodeChips, parseChips } from '@feltcircle/chip-export';
import {
  applyCommand,
  confirmedChips,
  connectSeat,
  createLocalRoom,
  createOnlineRoom,
  disconnectSeat,
  generateRoomId,
  generateUniqueRoomId,
  joinSeat,
  nextWakeAt,
  reconcileConnections,
  tick,
  toView,
  type RoomState,
} from '../src/index.js';

let now = 1_000_000;
let ids = 0;
function cmd(state: RoomState, seat: number | null, c: Command, opts: { local?: boolean; id?: string } = {}) {
  return applyCommand(state, { seat, local: opts.local }, c, now, opts.id ?? `c${++ids}`);
}
function ok(state: RoomState, seat: number | null, c: Command, local = false) {
  const r = cmd(state, seat, c, { local });
  if (!r.ok) throw new Error(`${c.type} failed: ${r.error}`);
  return r.state;
}

/** Online room with `n` connected players; seat 1 is host. */
function onlineRoom(n: number, settings = {}): RoomState {
  let s = createOnlineRoom({ id: 'ABCDE', hostToken: 't1', now, settings });
  s = connectSeat(s, 1, now);
  for (let i = 2; i <= n; i++) {
    s = joinSeat(s, i, `P${i}`, `t${i}`, now);
    s = connectSeat(s, i, now);
  }
  return s;
}

describe('seating', () => {
  it('host occupies seat 1 and others pick free seats', () => {
    let s = onlineRoom(1, { maxPlayers: 3 });
    expect(s.hostSeat).toBe(1);
    s = joinSeat(s, 3, 'Bob', 'tb', now);
    expect(() => joinSeat(s, 3, 'Eve', 'te', now)).toThrow('SEAT_TAKEN');
    expect(() => joinSeat(s, 4, 'Eve', 'te', now)).toThrow('INVALID_SEAT');
    s = joinSeat(s, 2, '', 'tc', now);
    expect(Object.keys(s.seats)).toEqual(['1', '2', '3']);
  });

  it('offline seats can be taken over with a new token; online seats cannot', () => {
    let s = onlineRoom(2);
    expect(() => joinSeat(s, 2, 'X', 'new', now, true)).toThrow('SEAT_TAKEN');
    s = disconnectSeat(s, 2, now);
    s = joinSeat(s, 2, '', 'new', now, true);
    expect(s.seats[2].token).toBe('new');
    expect(s.seats[2].nickname).toBe('P2');
  });

  it('game can start without filling all seats but needs two players', () => {
    const one = onlineRoom(1);
    expect(cmd(one, 1, { type: 'host:start' }).error).toBe('NOT_ENOUGH_PLAYERS');
    const s = ok(onlineRoom(3), 1, { type: 'host:start' });
    expect(s.status).toBe('playing');
    expect(s.game!.hand!.seats.map((x) => x.seat)).toEqual([1, 2, 3]);
    expect(() => joinSeat(s, 4, 'late', 't', now)).toThrow('GAME_STARTED');
  });

  it('only the host may run host commands', () => {
    const s = onlineRoom(3);
    expect(cmd(s, 2, { type: 'host:start' }).error).toBe('NOT_HOST');
  });
});

describe('host transfer and claim', () => {
  it('voluntary transfer keeps seats, dealer, chips and pots unchanged', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    s = ok(s, s.game!.hand!.toAct!, { type: 'act', action: { type: 'raise', amount: 60 } });
    const gameBefore = JSON.stringify(s.game);
    s = ok(s, 1, { type: 'host:transfer', seat: 3 });
    expect(s.hostSeat).toBe(3);
    expect(JSON.stringify(s.game)).toBe(gameBefore);
    expect(cmd(s, 1, { type: 'host:pause' }).error).toBe('NOT_HOST');
  });

  it('claim succeeds only when the host is disconnected; first claim wins', () => {
    let s = onlineRoom(3);
    expect(cmd(s, 2, { type: 'claimHost' }).error).toBe('HOST_CONNECTED');
    s = disconnectSeat(s, 1, now);
    s = ok(s, 2, { type: 'claimHost' });
    expect(s.hostSeat).toBe(2);
    expect(cmd(s, 3, { type: 'claimHost' }).error).toBe('HOST_CONNECTED');
    // previous host returns to their seat without host rights
    s = connectSeat(s, 1, now);
    expect(s.hostSeat).toBe(2);
    expect(s.seats[1].connections).toBe(1);
    expect(s.log.some((l) => l.code === 'hostClaimed')).toBe(true);
  });
});

describe('disconnects and auto-fold', () => {
  it('enables auto-fold after 30 s on the server clock and folds when facing a bet', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    // D=1 SB=2 BB=3 → seat 1 to act
    expect(s.game!.hand!.toAct).toBe(1);
    s = disconnectSeat(s, 2, now);
    expect(nextWakeAt(s)).toBe(now + AUTO_FOLD_AFTER_MS);
    expect(tick(s, now + 29_999).changed).toBe(false);
    const r = tick(s, now + AUTO_FOLD_AFTER_MS);
    expect(r.changed).toBe(true);
    s = r.state;
    expect(toView(s, 1, now).seats.find((x) => x.seat === 2)!.autoFold).toBe(true);
    s = ok(s, 1, { type: 'act', action: { type: 'raise', amount: 100 } });
    // seat 2 auto-folded immediately, now seat 3
    const h = s.game!.hand!;
    expect(h.seats.find((x) => x.seat === 2)!.folded).toBe(true);
    expect(h.log.find((l) => l.seat === 2 && l.type === 'fold')!.auto).toBe(true);
    expect(h.toAct).toBe(3);
  });

  it('auto-fold folds even when checking would be free (the player is away from the table)', () => {
    let s = ok(onlineRoom(2), 1, { type: 'host:start' });
    s = disconnectSeat(s, 2, now);
    s = tick(s, now + AUTO_FOLD_AFTER_MS).state;
    s = ok(s, 1, { type: 'act', action: { type: 'call' } });
    // BB (seat 2) folded automatically; the hand is over.
    expect(s.game!.hand!.seats.find((x) => x.seat === 2)!.folded).toBe(true);
    expect(s.game!.hand!.phase).toBe('complete');
    expect(s.game!.chips).toEqual({ 1: 2020, 2: 1980 });
  });

  it('reconnecting disables auto-fold', () => {
    let s = onlineRoom(2);
    s = disconnectSeat(s, 2, now);
    s = tick(s, now + AUTO_FOLD_AFTER_MS).state;
    expect(s.seats[2].autoFold).toBe(true);
    s = connectSeat(s, 2, now);
    expect(s.seats[2].autoFold).toBe(false);
  });

  it('all-in players are never folded for being offline', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    s = ok(s, 1, { type: 'act', action: { type: 'allin' } });
    s = disconnectSeat(s, 1, now);
    s = tick(s, now + AUTO_FOLD_AFTER_MS).state;
    s = ok(s, 2, { type: 'act', action: { type: 'call' } });
    s = ok(s, 3, { type: 'act', action: { type: 'call' } });
    expect(s.game!.hand!.seats.find((x) => x.seat === 1)!.folded).toBe(false);
  });

  it('host can force-fold offline players only', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    expect(cmd(s, 1, { type: 'host:forceFold', seat: 2 }).error).toBe('PLAYER_ONLINE');
    s = disconnectSeat(s, 2, now);
    s = ok(s, 1, { type: 'host:forceFold', seat: 2 });
    s = ok(s, 1, { type: 'act', action: { type: 'call' } });
    expect(s.game!.hand!.seats.find((x) => x.seat === 2)!.folded).toBe(true);
  });

  it('reconciles connection counts after a restart', () => {
    let s = onlineRoom(3);
    s = reconcileConnections(s, { 2: 1 }, now + 5);
    expect(s.seats[1].connections).toBe(0);
    expect(s.seats[1].offlineSince).toBe(now + 5);
    expect(s.seats[2].connections).toBe(1);
  });
});

describe('pre-actions', () => {
  it('Call Any calls any amount, including all-in, and executes once', () => {
    let s = ok(onlineRoom(3, { startingChips: 1000 }), 1, { type: 'host:start' });
    s = ok(s, 3, { type: 'setPreAction', preAction: 'callany' });
    expect(toView(s, 3, now).myPreAction).toBe('callany');
    expect(toView(s, 2, now).myPreAction).toBe(null); // private
    s = ok(s, 1, { type: 'act', action: { type: 'allin' } });
    s = ok(s, 2, { type: 'act', action: { type: 'fold' } });
    const p3 = s.game!.hand!.seats.find((x) => x.seat === 3)!;
    expect(p3.allIn).toBe(true);
    expect(s.preActions[3]).toBeUndefined();
  });

  it('Call Any checks when no call is required', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    s = ok(s, 3, { type: 'setPreAction', preAction: 'callany' });
    s = ok(s, 1, { type: 'act', action: { type: 'call' } });
    s = ok(s, 2, { type: 'act', action: { type: 'call' } });
    expect(s.game!.hand!.phase).toBe('street-complete');
    expect(s.game!.hand!.log.at(-1)).toMatchObject({ seat: 3, type: 'check', auto: true });
  });

  it('Check/Fold folds facing a bet; pre-actions can be cleared; not on own turn', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    expect(cmd(s, 1, { type: 'setPreAction', preAction: 'fold' }).error).toBe('NOT_ALLOWED');
    s = ok(s, 2, { type: 'setPreAction', preAction: 'checkfold' });
    s = ok(s, 3, { type: 'setPreAction', preAction: 'fold' });
    s = ok(s, 3, { type: 'setPreAction', preAction: null });
    s = ok(s, 1, { type: 'act', action: { type: 'raise', amount: 80 } });
    expect(s.game!.hand!.seats.find((x) => x.seat === 2)!.folded).toBe(true);
    expect(s.game!.hand!.toAct).toBe(3);
  });

  it('pre-actions are cleared at the end of the hand and never carry over', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    s = ok(s, 3, { type: 'setPreAction', preAction: 'callany' });
    s = ok(s, 1, { type: 'act', action: { type: 'fold' } });
    s = ok(s, 2, { type: 'act', action: { type: 'fold' } });
    expect(s.game!.hand!.phase).toBe('complete');
    expect(s.preActions).toEqual({});
    s = ok(s, 1, { type: 'host:nextHand' });
    expect(s.preActions).toEqual({});
  });

  it('disconnected auto-fold overrides Call Any', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    s = ok(s, 2, { type: 'setPreAction', preAction: 'callany' });
    s = disconnectSeat(s, 2, now);
    s = tick(s, now + AUTO_FOLD_AFTER_MS).state;
    expect(s.preActions[2]).toBeUndefined();
    s = ok(s, 1, { type: 'act', action: { type: 'raise', amount: 60 } });
    expect(s.game!.hand!.seats.find((x) => x.seat === 2)!.folded).toBe(true);
  });
});

describe('idempotency and atomicity', () => {
  it('duplicate command ids are applied once', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    const c: Command = { type: 'act', action: { type: 'call' } };
    const a = cmd(s, 1, c, { id: 'same' });
    s = a.state;
    const v = s.version;
    const b = cmd(s, 1, c, { id: 'same' });
    expect(b.duplicate).toBe(true);
    expect(b.state.version).toBe(v);
  });

  it('failed commands leave state untouched', () => {
    const s = ok(onlineRoom(3), 1, { type: 'host:start' });
    const r = cmd(s, 2, { type: 'act', action: { type: 'call' } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NOT_YOUR_TURN');
    expect(r.state).toBe(s);
  });
});

describe('undo, pause and showdown flow', () => {
  it('undoes the last action and restores chips', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    const before = JSON.stringify(s.game);
    s = ok(s, 1, { type: 'act', action: { type: 'raise', amount: 500 } });
    s = ok(s, 1, { type: 'host:undo' });
    expect(JSON.stringify(s.game)).toBe(before);
    expect(cmd(s, 1, { type: 'host:undo' }).error).toBe('NOTHING_TO_UNDO');
    expect(s.log.at(-1)!.code).toBe('undo');
  });

  it('pause blocks actions', () => {
    let s = ok(onlineRoom(2), 1, { type: 'host:start' });
    s = ok(s, 1, { type: 'host:pause' });
    expect(cmd(s, 1, { type: 'act', action: { type: 'call' } }).error).toBe('PAUSED');
    s = ok(s, 1, { type: 'host:resume' });
    s = ok(s, 1, { type: 'act', action: { type: 'call' } });
  });

  it('full hand to showdown with host-selected winner', () => {
    let s = ok(onlineRoom(3), 1, { type: 'host:start' });
    s = ok(s, 1, { type: 'act', action: { type: 'call' } });
    s = ok(s, 2, { type: 'act', action: { type: 'call' } });
    s = ok(s, 3, { type: 'act', action: { type: 'check' } });
    for (let i = 0; i < 3; i++) {
      s = ok(s, 1, { type: 'host:advance' });
      for (const seat of [2, 3, 1]) s = ok(s, seat, { type: 'act', action: { type: 'check' } });
    }
    expect(s.game!.hand!.phase).toBe('showdown');
    expect(toView(s, 1, now).pots).toEqual([{ amount: 60, eligible: [1, 2, 3] }]);
    expect(cmd(s, 2, { type: 'host:award', winners: [[3]] }).error).toBe('NOT_HOST');
    s = ok(s, 1, { type: 'host:award', winners: [[3]] });
    expect(s.game!.chips).toEqual({ 1: 1980, 2: 1980, 3: 2040 });
    s = ok(s, 1, { type: 'host:nextHand' });
    expect(s.game!.hand!.dealer).toBe(2);
  });
});

describe('chip import', () => {
  it('stages an import in the lobby and applies it at start', () => {
    let s = onlineRoom(3);
    expect(cmd(s, 1, { type: 'host:import', seats: { 1: 500, 2: 700, 4: 100 }, resolution: null }).error).toBe('RESOLUTION_REQUIRED');
    s = ok(s, 1, { type: 'host:import', seats: { 1: 500, 2: 700, 4: 100 }, resolution: { missing: 'starting' } });
    expect(toView(s, 1, now).pendingImport).toEqual({ 1: 500, 2: 700, 3: 2000 });
    s = ok(s, 1, { type: 'host:start' });
    expect(totalChips(s.game!)).toBe(3200);
    expect(s.seats[1].nickname).toBe('');
    expect(s.seats[2].nickname).toBe('P2');
  });

  it('rejects imports with fewer than two funded seats', () => {
    const s = onlineRoom(2);
    expect(cmd(s, 1, { type: 'host:import', seats: { 1: 500, 2: 0 }, resolution: null }).error).toBe('IMPORT_NEEDS_TWO');
  });

  it('administrative chip reset only between hands', () => {
    let s = ok(onlineRoom(2), 1, { type: 'host:start' });
    expect(cmd(s, 1, { type: 'host:import', seats: { 1: 10, 2: 10 }, resolution: null }).error).toBe('HAND_IN_PROGRESS');
    s = ok(s, 1, { type: 'act', action: { type: 'fold' } });
    s = ok(s, 2, { type: 'setPreAction', preAction: null });
    s = ok(s, 1, { type: 'host:import', seats: { 1: 300, 2: 900 }, resolution: null });
    expect(s.game!.chips).toEqual({ 1: 300, 2: 900 });
    expect(s.game!.hand).toBe(null);
    expect(s.log.at(-1)!.code).toBe('chipReset');
    s = ok(s, 1, { type: 'host:nextHand' });
    expect(s.game!.hand!.number).toBe(2);
  });

  it('cross-mode: export from local, import into online room', () => {
    let local = createLocalRoom({ players: [{ seat: 1 }, { seat: 2 }, { seat: 3 }], now });
    local = ok(local, null, { type: 'host:start' }, true);
    local = ok(local, null, { type: 'act', seat: 1, action: { type: 'raise', amount: 100 } }, true);
    local = ok(local, null, { type: 'act', seat: 2, action: { type: 'fold' } }, true);
    // during a hand the export shows confirmed (start-of-hand) balances
    expect(confirmedChips(local.game)).toEqual({ 1: 2000, 2: 2000, 3: 2000 });
    local = ok(local, null, { type: 'act', seat: 3, action: { type: 'fold' } }, true);
    const text = encodeChips(confirmedChips(local.game)!);
    expect(text).toBe('FC1 1=2030 2=1990 3=1980 T=6000');
    const parsed = parseChips(text);
    if (!parsed.ok) throw new Error();
    let online = onlineRoom(3);
    online = ok(online, 1, { type: 'host:import', seats: parsed.state.seats, resolution: null });
    online = ok(online, 1, { type: 'host:start' });
    expect(online.game!.chips).toEqual({ 1: 2030, 2: 1990, 3: 1980 });
  });
});

describe('local mode', () => {
  it('one device acts for every seat and is always host', () => {
    let s = createLocalRoom({ players: [{ seat: 1, nickname: 'Ann' }, { seat: 2 }], now });
    s = ok(s, null, { type: 'host:start' }, true);
    expect(cmd(s, null, { type: 'act', seat: 2, action: { type: 'call' } }, { local: true }).error).toBe('NOT_YOUR_TURN');
    s = ok(s, null, { type: 'act', seat: 1, action: { type: 'call' } }, true);
    s = ok(s, null, { type: 'act', seat: 2, action: { type: 'check' } }, true);
    expect(s.game!.hand!.phase).toBe('street-complete');
    expect(nextWakeAt(s)).toBe(null);
  });

  it('manual sit-out auto-folds a seat', () => {
    let s = createLocalRoom({ players: [{ seat: 1 }, { seat: 2 }, { seat: 3 }], now });
    s = ok(s, null, { type: 'setAway', seat: 2, away: true }, true);
    s = ok(s, null, { type: 'host:start' }, true);
    s = ok(s, null, { type: 'act', seat: 1, action: { type: 'raise', amount: 60 } }, true);
    expect(s.game!.hand!.seats.find((x) => x.seat === 2)!.folded).toBe(true);
  });
});

describe('expiry', () => {
  it('expires 24 h after last meaningful activity, not after connects', () => {
    let s = onlineRoom(2);
    const t0 = s.lastActivityAt;
    s = connectSeat(disconnectSeat(s, 2, now + 1000), 2, now + 2000);
    expect(s.lastActivityAt).toBe(t0);
    expect(tick(s, t0 + ROOM_TTL_MS - 1).expired).toBe(false);
    expect(tick(s, t0 + ROOM_TTL_MS).expired).toBe(true);
    now += 5000;
    s = ok(s, 1, { type: 'setNickname', nickname: 'Host' });
    expect(s.lastActivityAt).toBe(now);
  });
});

describe('room ids', () => {
  it('uses the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) expect(generateRoomId()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$/);
  });

  it('retries on collisions', async () => {
    const taken = new Set<string>();
    let calls = 0;
    const id = await generateUniqueRoomId((x) => {
      calls++;
      if (calls < 3) {
        taken.add(x);
        return true;
      }
      return taken.has(x);
    });
    expect(calls).toBe(3);
    expect(taken.has(id)).toBe(false);
  });
});
