import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { RoomView } from '@feltcircle/game-protocol';
import { useI18n } from '../lib/i18n';
import { sounds, type SoundPrefs } from '../lib/sound';
import { soundEvents } from '../lib/sound-events';

export function useSoundPrefs(): [SoundPrefs, (p: SoundPrefs) => void] {
  const prefs = useSyncExternalStore(
    (fn) => sounds.subscribe(fn),
    () => sounds.prefs,
  );
  return [prefs, (p) => sounds.setPrefs(p)];
}

/** Play sounds for confirmed events as authoritative room views arrive. */
export function useGameSounds(room: RoomView) {
  const prev = useRef<RoomView | null>(null);
  useEffect(() => {
    const names = soundEvents(prev.current, room);
    prev.current = room;
    if (names.length) sounds.playAll(names);
  }, [room]);
  useEffect(() => sounds.preload(), []);
}

/** Per-device sound settings: on/off and volume (saved locally). */
export function SoundSettings() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useSoundPrefs();
  return (
    <div className="field sound-settings">
      <span>{t('sound.title')}</span>
      <label className="toggle-row">
        <input type="checkbox" checked={prefs.enabled} onChange={(e) => setPrefs({ ...prefs, enabled: e.target.checked })} />
        <span>{t('sound.enabled')}</span>
      </label>
      <label className="toggle-row">
        <span className="muted small">{t('sound.volume')}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          aria-label={t('sound.volume')}
          disabled={!prefs.enabled}
          value={Math.round(prefs.volume * 100)}
          onChange={(e) => setPrefs({ ...prefs, volume: Number(e.target.value) / 100 })}
        />
        <button className="btn btn-small" disabled={!prefs.enabled} onClick={() => void sounds.play('raise')}>
          ▶ {t('sound.test')}
        </button>
      </label>
    </div>
  );
}

export function MuteButton() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useSoundPrefs();
  const label = prefs.enabled ? t('sound.mute') : t('sound.unmute');
  return (
    <button className="icon-btn" aria-label={label} title={label} aria-pressed={!prefs.enabled} onClick={() => setPrefs({ ...prefs, enabled: !prefs.enabled })}>
      <SpeakerIcon muted={!prefs.enabled} />
    </button>
  );
}

/** Speaker icon as inline SVG (renders the same on every device, unlike emoji). */
function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {muted ? (
        <path d="M17 9l5 6M22 9l-5 6" />
      ) : (
        <>
          <path d="M16.5 8.5a5 5 0 0 1 0 7" />
          <path d="M19.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}
