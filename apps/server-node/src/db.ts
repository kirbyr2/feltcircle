import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expiresAt, nextTimerAt, type RoomState } from '@feltcircle/room-core';

/** Ordered schema migrations; index + 1 = PRAGMA user_version after applying. */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS rooms (
     id TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     version INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS rooms_expires ON rooms(expires_at);`,
  // Pending game timers (showdown countdown, disconnect auto-fold): rooms with one are
  // loaded at start-up so the timer fires even if nobody reconnects.
  `ALTER TABLE rooms ADD COLUMN wake_at INTEGER;
   CREATE INDEX IF NOT EXISTS rooms_wake ON rooms(wake_at) WHERE wake_at IS NOT NULL;`,
];

/** Embedded SQLite room store (Node's built-in `node:sqlite`; no separate database server). */
export class RoomDb {
  private db: DatabaseSync;
  private stmts: ReturnType<RoomDb['prepare']>;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.stmts = this.prepare();
  }

  private migrate() {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  private prepare() {
    return {
      get: this.db.prepare('SELECT state FROM rooms WHERE id = ? AND expires_at > ?'),
      exists: this.db.prepare('SELECT 1 AS x FROM rooms WHERE id = ? AND expires_at > ?'),
      put: this.db.prepare(
        `INSERT INTO rooms (id, state, version, updated_at, expires_at, wake_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, version = excluded.version,
           updated_at = excluded.updated_at, expires_at = excluded.expires_at, wake_at = excluded.wake_at`,
      ),
      timers: this.db.prepare('SELECT id FROM rooms WHERE wake_at IS NOT NULL AND expires_at > ?'),
      del: this.db.prepare('DELETE FROM rooms WHERE id = ?'),
      expired: this.db.prepare('DELETE FROM rooms WHERE expires_at <= ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE expires_at > ?'),
    };
  }

  get(id: string, now: number): RoomState | null {
    const row = this.stmts.get.get(id, now) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as RoomState) : null;
  }

  exists(id: string, now: number): boolean {
    return !!this.stmts.exists.get(id, now);
  }

  /** Single-statement upsert: atomic. */
  put(state: RoomState, now: number) {
    this.stmts.put.run(state.id, JSON.stringify(state), state.version, now, expiresAt(state) ?? now, nextTimerAt(state));
  }

  /** Rooms with a pending game timer (to be loaded after a restart). */
  roomsWithTimers(now: number): string[] {
    return (this.stmts.timers.all(now) as { id: string }[]).map((r) => r.id);
  }

  delete(id: string) {
    this.stmts.del.run(id);
  }

  deleteExpired(now: number): number {
    return Number(this.stmts.expired.run(now).changes);
  }

  activeCount(now: number): number {
    return (this.stmts.count.get(now) as { n: number }).n;
  }

  close() {
    this.db.close();
  }
}

/** Write a consistent copy of the database to `target` using SQLite's VACUUM INTO (works while in use). */
export function backupDatabase(file: string, target: string): void {
  if (fs.existsSync(target)) throw new Error(`Refusing to overwrite existing file: ${target}`);
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(path.resolve(target));
  } finally {
    db.close();
  }
}
