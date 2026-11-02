import { detectBackend, type BackendStatus, type TokenStore } from '@feltcircle/game-session';
import { lsGet, lsSet } from './storage';

const SERVER_OVERRIDE = 'fc.server';

/** Optional `config.json` next to index.html: `{ "backendUrl": "https://chips.example.com" }`. */
async function loadRuntimeConfig(): Promise<{ backendUrl?: string }> {
  try {
    const res = await fetch('./config.json', { cache: 'no-store' });
    if (!res.ok) return {};
    return (await res.json()) as { backendUrl?: string };
  } catch {
    return {};
  }
}

export function validServerUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function getServerOverride(): string | null {
  return lsGet(SERVER_OVERRIDE);
}

export function setServerOverride(url: string | null) {
  lsSet(SERVER_OVERRIDE, url ? url.replace(/\/$/, '') : null);
}

/**
 * Backend resolution order: user override (settings or invite link) →
 * `config.json` → same origin. No domain is hard-coded.
 */
export async function resolveBackendUrl(): Promise<string> {
  const override = getServerOverride();
  if (override && validServerUrl(override)) return override;
  const cfg = await loadRuntimeConfig();
  if (cfg.backendUrl && validServerUrl(cfg.backendUrl)) return cfg.backendUrl.replace(/\/$/, '');
  return location.origin;
}

export async function probeBackend(): Promise<BackendStatus> {
  return detectBackend(await resolveBackendUrl());
}

/** Reconnection tokens per backend + room (browser-local session data). */
export function tokenStore(baseUrl: string): TokenStore {
  const key = (roomId: string) => `fc.token.${baseUrl}|${roomId}`;
  return {
    get: (id) => lsGet(key(id)),
    set: (id, t) => lsSet(key(id), t),
    remove: (id) => lsSet(key(id), null),
  };
}

const LAST_ROOM = 'fc.lastRoom';

export function rememberRoom(baseUrl: string, roomId: string | null) {
  lsSet(LAST_ROOM, roomId ? JSON.stringify({ baseUrl, roomId, at: Date.now() }) : null);
}

export function lastRoom(): { baseUrl: string; roomId: string } | null {
  const raw = lsGet(LAST_ROOM);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { baseUrl: string; roomId: string; at: number };
    if (Date.now() - v.at > 24 * 3600_000) return null;
    return v;
  } catch {
    return null;
  }
}
