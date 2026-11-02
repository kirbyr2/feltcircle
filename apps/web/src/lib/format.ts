import type { RoomView, SeatView } from '@feltcircle/game-protocol';

type T = (key: string, params?: Record<string, string | number>) => string;

/** Display name: optional nickname, otherwise "Player N" (presentation only, never an identity). */
export function seatName(t: T, room: RoomView | null, seat: number): string {
  const s: SeatView | undefined = room?.seats.find((x) => x.seat === seat);
  return s?.nickname ? s.nickname : t('common.player', { n: seat });
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
