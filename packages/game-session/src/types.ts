import type { Command, RoomView } from '@feltcircle/game-protocol';

export type ConnectionState = 'local' | 'connecting' | 'online' | 'reconnecting' | 'closed';

export interface SessionSnapshot {
  room: RoomView | null;
  /** Seat controlled by this device (online). Local Mode controls every seat: null. */
  mySeat: number | null;
  /** Online late join: seat requested and awaiting host approval. */
  pendingSeat: number | null;
  isHost: boolean;
  local: boolean;
  connection: ConnectionState;
  /** A command is awaiting server confirmation. */
  pending: boolean;
  lastError: { code: string; at: number } | null;
  /** Set when the room no longer exists. */
  gone: 'host' | 'expired' | 'notfound' | null;
}

export interface CommandOutcome {
  ok: boolean;
  error?: string;
}

/** Common interface for Local Mode and Online Mode. UI code depends only on this. */
export interface GameSession {
  getSnapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
  send(cmd: Command): Promise<CommandOutcome>;
  dispose(): void;
}

export class Emitter {
  private listeners = new Set<() => void>();
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit() {
    for (const l of [...this.listeners]) l();
  }
}

export function randomId(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
