import type { Command } from '@feltcircle/game-protocol';
import { applyCommand, nextTimerAt, normalizeRoom, tick, toView, type RoomState } from '@feltcircle/room-core';
import { Emitter, randomId, type CommandOutcome, type GameSession, type SessionSnapshot } from './types.js';

export interface LocalStore {
  save(state: RoomState): Promise<void> | void;
  clear(): Promise<void> | void;
}

/**
 * Local Mode: the same room state machine as the server, running in the
 * browser with a local actor that is host and may act for every seat.
 */
export class LocalSession implements GameSession {
  private emitter = new Emitter();
  private snapshot: SessionSnapshot;

  constructor(
    private state: RoomState,
    private readonly store: LocalStore,
    private readonly now: () => number = Date.now,
  ) {
    // Games saved on this device by an older version lack newer fields.
    this.state = normalizeRoom(state);
    this.snapshot = this.makeSnapshot(null);
    this.schedule();
  }

  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** Local Mode runs the showdown countdown on this device (same rules as the server). */
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const at = nextTimerAt(this.state);
    if (at === null || this.disposed) return;
    this.timer = setTimeout(() => void this.onTimer(), Math.max(0, Math.min(at - this.now(), 2 ** 31 - 1)));
  }

  private async onTimer() {
    this.timer = null;
    const r = tick(this.state, this.now());
    if (r.changed) {
      this.state = r.state;
      this.snapshot = this.makeSnapshot(null);
      this.emitter.emit();
      await this.store.save(this.state);
    }
    this.schedule();
  }

  get roomState(): RoomState {
    return this.state;
  }

  private makeSnapshot(lastError: SessionSnapshot['lastError']): SessionSnapshot {
    return {
      room: toView(this.state, null, this.now()),
      mySeat: null,
      pendingSeat: null,
      isHost: true,
      local: true,
      connection: 'local',
      pending: false,
      lastError,
      gone: null,
    };
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(fn: () => void) {
    return this.emitter.subscribe(fn);
  }

  async send(cmd: Command): Promise<CommandOutcome> {
    const r = applyCommand(this.state, { seat: null, local: true }, cmd, this.now(), randomId());
    if (!r.ok) {
      this.snapshot = { ...this.snapshot, lastError: { code: r.error!, at: this.now() } };
      this.emitter.emit();
      return { ok: false, error: r.error };
    }
    if (r.deleted) {
      await this.store.clear();
      this.snapshot = { ...this.snapshot, gone: 'host' };
      this.emitter.emit();
      return { ok: true };
    }
    this.state = r.state;
    this.snapshot = this.makeSnapshot(null);
    this.schedule();
    this.emitter.emit();
    await this.store.save(this.state);
    return { ok: true };
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
