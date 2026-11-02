import { lsGet, lsSet } from './storage';
import { SOUND_NAMES, type SoundName } from './sound-events';

export interface SoundPrefs {
  enabled: boolean;
  /** 0…1 */
  volume: number;
}

export const SOUND_KEY = 'fc.sound';
export const DEFAULT_SOUND_PREFS: SoundPrefs = { enabled: true, volume: 0.6 };

/** Read this device's sound preferences (invalid or missing values fall back to the defaults). */
export function loadSoundPrefs(): SoundPrefs {
  try {
    const raw = JSON.parse(lsGet(SOUND_KEY) ?? 'null') as Partial<SoundPrefs> | null;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SOUND_PREFS };
    const volume = typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : DEFAULT_SOUND_PREFS.volume;
    return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SOUND_PREFS.enabled, volume };
  } catch {
    return { ...DEFAULT_SOUND_PREFS };
  }
}

export function saveSoundPrefs(p: SoundPrefs): void {
  lsSet(SOUND_KEY, JSON.stringify({ enabled: !!p.enabled, volume: Math.max(0, Math.min(1, p.volume)) }));
}

type AudioCtx = AudioContext;

/**
 * Plays the bundled sound files with the Web Audio API. Browsers only allow
 * audio after a user gesture, so the audio context is created on the first
 * tap/key press; until then, sounds are silently skipped.
 */
class SoundPlayer {
  private ctx: AudioCtx | null = null;
  private buffers = new Map<SoundName, Promise<AudioBuffer | null>>();
  private listeners = new Set<() => void>();
  prefs: SoundPrefs = typeof localStorage !== 'undefined' ? loadSoundPrefs() : { ...DEFAULT_SOUND_PREFS };

  constructor() {
    if (typeof window === 'undefined') return;
    const unlock = () => {
      this.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private unlock() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx ??= new Ctor();
      void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  setPrefs(p: SoundPrefs) {
    this.prefs = { ...p };
    saveSoundPrefs(p);
    for (const l of this.listeners) l();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private load(name: SoundName): Promise<AudioBuffer | null> {
    let p = this.buffers.get(name);
    if (!p) {
      const ctx = this.ctx!;
      p = fetch(new URL(`sounds/${name}.wav`, document.baseURI))
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b))
        .catch(() => null);
      this.buffers.set(name, p);
    }
    return p;
  }

  async play(name: SoundName, delayMs = 0) {
    if (!this.prefs.enabled || this.prefs.volume <= 0 || !this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const buffer = await this.load(name);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = this.prefs.volume;
    src.buffer = buffer;
    src.connect(gain).connect(ctx.destination);
    src.start(ctx.currentTime + delayMs / 1000);
  }

  playAll(names: SoundName[]) {
    names.forEach((n, i) => void this.play(n, i * 140));
  }

  /** Warm the cache so the first sound of a game is not delayed. */
  preload() {
    if (!this.ctx) return;
    for (const n of SOUND_NAMES) void this.load(n);
  }
}

export const sounds = new SoundPlayer();
