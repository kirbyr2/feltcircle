import type { RoomView } from '@feltcircle/game-protocol';
import type { HandLogEntry } from '@feltcircle/poker-engine';

export const SOUND_NAMES = ['blind', 'bet', 'call', 'raise', 'allin', 'fold', 'check', 'win', 'hand'] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

const MAX_PER_UPDATE = 3;

function forEntry(e: HandLogEntry): SoundName | null {
  switch (e.type) {
    case 'sb':
    case 'bb':
      return 'blind';
    case 'check':
      return 'check';
    case 'fold':
    case 'muck':
      return 'fold';
    case 'call':
      return e.allIn ? 'allin' : 'call';
    case 'bet':
      return e.allIn ? 'allin' : 'bet';
    case 'raise':
      return e.allIn ? 'allin' : 'raise';
    case 'allin':
      return 'allin';
    case 'win':
      return 'win';
    default:
      return null;
  }
}

/**
 * Sounds for the confirmed game events between two authoritative room views.
 * Sounds come only from state the server (or Local Mode engine) has accepted,
 * never from button presses. The first view after opening a room, or the same
 * version received again after a reconnect, plays nothing, so nothing repeats.
 */
export function soundEvents(prev: RoomView | null, next: RoomView): SoundName[] {
  if (!prev || prev.id !== next.id || next.version <= prev.version) return [];
  const nh = next.game?.hand;
  if (!nh) return [];
  const ph = prev.game?.hand;
  let entries: HandLogEntry[];
  if (ph && ph.number === nh.number) entries = nh.log.slice(ph.log.length);
  else if (!ph || nh.number > ph.number) entries = nh.log;
  else return [];
  const out: SoundName[] = [];
  for (const e of entries) {
    const s = forEntry(e);
    if (s && !out.includes(s)) out.push(s);
  }
  const justCompleted = nh.phase === 'complete' && !(ph && ph.number === nh.number && ph.phase === 'complete');
  if (justCompleted && !out.includes('hand')) out.push('hand');
  return out.slice(0, MAX_PER_UPDATE);
}
