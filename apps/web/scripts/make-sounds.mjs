// Generates FeltCircle's sound effects (public/sounds/*.wav).
// Every sound is synthesised here from scratch (damped resonances + filtered
// noise with a fixed random seed), so the assets are original, reproducible
// and covered by the project's MIT license. Run: npm run sounds -w @feltcircle/web
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds');

// Deterministic PRNG (mulberry32) so builds are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * RATE));

/** One clay/ceramic chip hitting another: a few bright damped partials plus a noise tick. */
function chip(buf, at, gain, rand) {
  const start = Math.floor(at * RATE);
  const base = 2600 + rand() * 900;
  const partials = [
    [base, 1, 55],
    [base * 1.52 + rand() * 80, 0.6, 70],
    [base * 2.31 + rand() * 120, 0.35, 90],
    [base * 0.47, 0.25, 40],
  ];
  const len = Math.floor(0.06 * RATE);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / RATE;
    let v = 0;
    for (const [f, a, d] of partials) v += a * Math.sin(2 * Math.PI * f * t) * Math.exp(-d * t);
    v += (rand() * 2 - 1) * 0.9 * Math.exp(-900 * t); // contact transient
    buf[start + i] += gain * v;
  }
}

/** Soft knuckle knock on a felt table. */
function knock(buf, at, gain, rand) {
  const start = Math.floor(at * RATE);
  const len = Math.floor(0.12 * RATE);
  let lp = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / RATE;
    const body = Math.sin(2 * Math.PI * (140 + 40 * Math.exp(-40 * t)) * t) * Math.exp(-38 * t);
    lp += 0.25 * ((rand() * 2 - 1) - lp);
    buf[start + i] += gain * (body + lp * 0.6 * Math.exp(-120 * t));
  }
}

/** Card sliding across felt: band-limited noise with a smooth swell. */
function swish(buf, at, dur, gain, rand) {
  const start = Math.floor(at * RATE);
  const len = Math.floor(dur * RATE);
  let lp = 0;
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const x = i / len;
    const env = Math.sin(Math.PI * Math.min(1, x * 1.4)) ** 2 * (1 - x * 0.5);
    const n = rand() * 2 - 1;
    lp += 0.35 * (n - lp);
    hp = 0.92 * (hp + lp - prev);
    prev = lp;
    buf[start + i] += gain * env * hp;
  }
}

/** Gentle bell for "hand complete". */
function chime(buf, at, freq, gain) {
  const start = Math.floor(at * RATE);
  const len = Math.floor(0.7 * RATE);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / RATE;
    const env = Math.min(1, t * 200) * Math.exp(-5 * t);
    buf[start + i] += gain * env * (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * freq * 2.01 * t));
  }
}

function chips(buf, count, { start = 0, spacing = 0.05, jitter = 0.02, gain = 0.5, decay = 0.92 }, rand) {
  let at = start;
  let g = gain;
  for (let i = 0; i < count; i++) {
    chip(buf, at, g * (0.75 + rand() * 0.25), rand);
    at += spacing + rand() * jitter;
    g *= decay;
  }
}

const SOUNDS = {
  blind: (r) => {
    const b = buffer(0.2);
    chips(b, 2, { spacing: 0.045, gain: 0.45 }, r);
    return b;
  },
  bet: (r) => {
    const b = buffer(0.3);
    chips(b, 3, { spacing: 0.055, gain: 0.55 }, r);
    return b;
  },
  call: (r) => {
    const b = buffer(0.25);
    chips(b, 2, { spacing: 0.06, gain: 0.5 }, r);
    return b;
  },
  raise: (r) => {
    const b = buffer(0.4);
    chips(b, 5, { spacing: 0.045, gain: 0.6, decay: 0.95 }, r);
    return b;
  },
  allin: (r) => {
    const b = buffer(0.75);
    knock(b, 0, 0.35, r);
    chips(b, 14, { start: 0.02, spacing: 0.032, jitter: 0.02, gain: 0.6, decay: 0.95 }, r);
    return b;
  },
  fold: (r) => {
    const b = buffer(0.25);
    swish(b, 0, 0.22, 0.9, r);
    return b;
  },
  check: (r) => {
    const b = buffer(0.32);
    knock(b, 0, 0.8, r);
    knock(b, 0.13, 0.65, r);
    return b;
  },
  win: (r) => {
    const b = buffer(0.8);
    swish(b, 0, 0.35, 0.35, r);
    chips(b, 10, { start: 0.08, spacing: 0.04, jitter: 0.03, gain: 0.55, decay: 0.9 }, r);
    return b;
  },
  hand: (r) => {
    const b = buffer(0.9);
    chime(b, 0, 784, 0.35);
    chime(b, 0.12, 1175, 0.25);
    void r;
    return b;
  },
};

function toWav(samples) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0 ? 0.7 / peak : 1;
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    // short fade-out avoids clicks at the end
    const fade = Math.min(1, (samples.length - i) / (0.01 * RATE));
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * scale * fade)) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

fs.mkdirSync(OUT, { recursive: true });
let seed = 1;
for (const [name, make] of Object.entries(SOUNDS)) {
  const file = path.join(OUT, `${name}.wav`);
  fs.writeFileSync(file, toWav(make(rng(seed++ * 7919))));
  console.log(`${name}.wav  ${fs.statSync(file).size} bytes`);
}
