import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  /** Optional directory with the built web app to serve (single-process deployment). */
  staticDir: string | null;
  /** Trust X-Forwarded-For (enable behind Nginx/OpenResty). */
  trustProxy: boolean;
  /** Comma-separated allowed origins for cross-origin frontends, or `*`. */
  corsOrigins: string[];
  /** Rooms one client IP may create per hour. */
  roomCreateLimit: number;
  /** Maximum simultaneously stored active rooms. */
  maxRooms: number;
  cleanupIntervalMs: number;
}

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? Math.floor(n) : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  return {
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 8787),
    dataDir,
    dbFile: env.DB_FILE === ':memory:' ? ':memory:' : env.DB_FILE ? path.resolve(env.DB_FILE) : path.join(dataDir, 'feltcircle.sqlite'),
    staticDir: env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null,
    trustProxy: bool(env.TRUST_PROXY, false),
    corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
    roomCreateLimit: int(env.ROOM_CREATE_LIMIT, 30),
    maxRooms: int(env.MAX_ROOMS, 5000),
    cleanupIntervalMs: int(env.CLEANUP_INTERVAL_MS, 60_000),
  };
}
