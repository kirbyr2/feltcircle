import { ROOM_ID_ALPHABET, ROOM_ID_LENGTH } from '@feltcircle/game-protocol';

type RandomFill = (buf: Uint8Array) => Uint8Array;

const defaultFill: RandomFill = (buf) => crypto.getRandomValues(buf);

/** Uniform random index in [0, n) using rejection sampling (no modulo bias). */
function randomIndex(n: number, fill: RandomFill): number {
  const limit = 256 - (256 % n);
  const buf = new Uint8Array(1);
  for (;;) {
    fill(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Cryptographically random five-character room ID (no 0/O/1/I/L). */
export function generateRoomId(fill: RandomFill = defaultFill): string {
  let id = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i++) id += ROOM_ID_ALPHABET[randomIndex(ROOM_ID_ALPHABET.length, fill)];
  return id;
}

/**
 * Generate an ID not in use. `exists` is checked for every candidate; after
 * `maxAttempts` collisions an error is thrown (the ID space has ~28.6M values).
 */
export async function generateUniqueRoomId(
  exists: (id: string) => boolean | Promise<boolean>,
  fill: RandomFill = defaultFill,
  maxAttempts = 20,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const id = generateRoomId(fill);
    if (!(await exists(id))) return id;
  }
  throw new Error('could not allocate a room id');
}

/** URL-safe random secret used as a seat reconnection token. */
export function randomToken(bytes = 18, fill: RandomFill = defaultFill): string {
  const buf = fill(new Uint8Array(bytes));
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
