import { isCompatibleBackend, type Capabilities, type RoomSettings, type RoomSummary } from '@feltcircle/game-protocol';

export type BackendStatus =
  | { state: 'checking' }
  | { state: 'available'; baseUrl: string; capabilities: Capabilities }
  | { state: 'unavailable'; reason: 'network' | 'incompatible' | 'not-found' };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Probe `GET {base}/api/capabilities` without blocking the app. */
export async function detectBackend(baseUrl: string, fetchImpl: FetchLike = fetch, timeoutMs = 5000): Promise<BackendStatus> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(joinUrl(baseUrl, '/api/capabilities'), { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { state: 'unavailable', reason: 'not-found' };
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { state: 'unavailable', reason: 'incompatible' };
    }
    if (!isCompatibleBackend(data)) return { state: 'unavailable', reason: 'incompatible' };
    return { state: 'available', baseUrl, capabilities: data };
  } catch {
    return { state: 'unavailable', reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

export interface CreatedRoom {
  roomId: string;
  token: string;
  seat: number;
}

export async function createRoomRequest(
  baseUrl: string,
  body: { game?: string; settings: Partial<RoomSettings>; nickname: string },
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; room: CreatedRoom } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(joinUrl(baseUrl, '/api/rooms'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data) return { ok: false, error: (data?.error as string) ?? (res.status === 429 ? 'RATE_LIMITED' : 'NETWORK') };
    return { ok: true, room: data as unknown as CreatedRoom };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function fetchRoomSummary(
  baseUrl: string,
  roomId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; room: RoomSummary } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(joinUrl(baseUrl, `/api/rooms/${roomId}`));
    if (res.status === 404) return { ok: false, error: 'ROOM_NOT_FOUND' };
    if (!res.ok) return { ok: false, error: 'NETWORK' };
    return { ok: true, room: (await res.json()) as RoomSummary };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}
