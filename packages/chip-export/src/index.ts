/**
 * FeltCircle chip-state export format.
 *
 * Only seat numbers and chip balances are exported — never room IDs, names,
 * tokens, hosts, dealer positions or history. Two equivalent encodings:
 *
 *   Compact (default):  FC1 1=2500 2=1750 3=3200 4=550 T=8000
 *   JSON:               {"version":1,"seats":{"1":2500,"2":1750,"3":3200,"4":550}}
 *
 * `FC1` = format version 1. `T=` is an optional checksum (sum of all chips).
 * Separators between entries may be spaces, commas, semicolons or newlines.
 */

export const CHIP_FORMAT_VERSION = 1;
export const MIN_SEAT = 1;
export const MAX_SEAT = 10;
export const MAX_CHIPS = 1_000_000_000;

export type SeatChips = Record<number, number>;

export interface ChipState {
  version: 1;
  seats: SeatChips;
}

export type ChipImportErrorCode =
  | 'EMPTY'
  | 'UNKNOWN_FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_SEAT'
  | 'INVALID_CHIPS'
  | 'DUPLICATE_SEAT'
  | 'TOTAL_MISMATCH'
  | 'NO_SEATS';

export type ParseResult =
  | { ok: true; state: ChipState; total: number }
  | { ok: false; error: ChipImportErrorCode; detail?: string };

function sortedEntries(seats: SeatChips): [number, number][] {
  return Object.entries(seats)
    .map(([k, v]) => [Number(k), v] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

function validateSeats(seats: SeatChips): void {
  for (const [seat, chips] of sortedEntries(seats)) {
    if (!isValidSeat(seat)) throw new Error(`invalid seat ${seat}`);
    if (!isValidChips(chips)) throw new Error(`invalid chips for seat ${seat}`);
  }
}

export function isValidSeat(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_SEAT && n <= MAX_SEAT;
}

export function isValidChips(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_CHIPS;
}

export function totalOf(seats: SeatChips): number {
  return Object.values(seats).reduce((a, b) => a + b, 0);
}

/** Compact human-copyable encoding, e.g. `FC1 1=2500 2=1750 T=4250`. */
export function encodeChips(seats: SeatChips): string {
  validateSeats(seats);
  const body = sortedEntries(seats)
    .map(([s, c]) => `${s}=${c}`)
    .join(' ');
  return `FC${CHIP_FORMAT_VERSION} ${body} T=${totalOf(seats)}`;
}

/** JSON encoding (same information as the compact form). */
export function encodeChipsJson(seats: SeatChips): string {
  validateSeats(seats);
  const out: Record<string, number> = {};
  for (const [s, c] of sortedEntries(seats)) out[String(s)] = c;
  return JSON.stringify({ version: CHIP_FORMAT_VERSION, seats: out });
}

/** Parse either encoding. Never throws. */
export function parseChips(input: string): ParseResult {
  const text = (input ?? '').trim();
  if (!text) return { ok: false, error: 'EMPTY' };
  if (text.startsWith('{')) return parseJson(text);
  const m = /^FC(\d+)\b/i.exec(text);
  if (!m) return { ok: false, error: 'UNKNOWN_FORMAT' };
  if (Number(m[1]) !== CHIP_FORMAT_VERSION) return { ok: false, error: 'UNSUPPORTED_VERSION', detail: m[1] };
  const tokens = text
    .slice(m[0].length)
    .split(/[\s,;]+/)
    .filter(Boolean);
  const seats: SeatChips = {};
  let declaredTotal: number | null = null;
  for (const tok of tokens) {
    const kv = /^([^=:]+)[=:](.*)$/.exec(tok);
    if (!kv) return { ok: false, error: 'UNKNOWN_FORMAT', detail: tok };
    const [, rawKey, rawVal] = kv;
    if (!/^\d+$/.test(rawVal)) {
      return { ok: false, error: 'INVALID_CHIPS', detail: tok };
    }
    const val = Number(rawVal);
    if (/^t$/i.test(rawKey)) {
      if (declaredTotal !== null) return { ok: false, error: 'UNKNOWN_FORMAT', detail: tok };
      declaredTotal = val;
      continue;
    }
    if (!/^\d+$/.test(rawKey) || !isValidSeat(Number(rawKey))) return { ok: false, error: 'INVALID_SEAT', detail: rawKey };
    const seat = Number(rawKey);
    if (seat in seats) return { ok: false, error: 'DUPLICATE_SEAT', detail: rawKey };
    if (!isValidChips(val)) return { ok: false, error: 'INVALID_CHIPS', detail: tok };
    seats[seat] = val;
  }
  return finish(seats, declaredTotal);
}

function parseJson(text: string): ParseResult {
  // Detect duplicate keys, which JSON.parse silently collapses.
  const keyRe = /"(\d+)"\s*:/g;
  const seen = new Set<string>();
  const seatsBlock = /"seats"\s*:\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
  for (const k of seatsBlock.matchAll(keyRe)) {
    const key = String(Number(k[1]));
    if (seen.has(key)) return { ok: false, error: 'DUPLICATE_SEAT', detail: key };
    seen.add(key);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'UNKNOWN_FORMAT' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'UNKNOWN_FORMAT' };
  const obj = data as Record<string, unknown>;
  if (obj.version !== CHIP_FORMAT_VERSION) return { ok: false, error: 'UNSUPPORTED_VERSION', detail: String(obj.version) };
  if (!obj.seats || typeof obj.seats !== 'object' || Array.isArray(obj.seats)) return { ok: false, error: 'UNKNOWN_FORMAT' };
  const seats: SeatChips = {};
  for (const [k, v] of Object.entries(obj.seats as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || !isValidSeat(Number(k))) return { ok: false, error: 'INVALID_SEAT', detail: k };
    if (!isValidChips(v)) return { ok: false, error: 'INVALID_CHIPS', detail: k };
    seats[Number(k)] = v;
  }
  const total = obj.total === undefined ? null : obj.total;
  if (total !== null && !isValidChips(total as number)) return { ok: false, error: 'TOTAL_MISMATCH' };
  return finish(seats, total as number | null);
}

function finish(seats: SeatChips, declaredTotal: number | null): ParseResult {
  if (Object.keys(seats).length === 0) return { ok: false, error: 'NO_SEATS' };
  const total = totalOf(seats);
  if (declaredTotal !== null && declaredTotal !== total) {
    return { ok: false, error: 'TOTAL_MISMATCH', detail: `${declaredTotal}≠${total}` };
  }
  return { ok: true, state: { version: 1, seats }, total };
}

export interface SeatDiff {
  /** Seats present in both the import and the room. */
  matched: number[];
  /** Imported seats with no player in the room. */
  onlyImported: number[];
  /** Occupied room seats missing from the import. */
  onlyRoom: number[];
}

export function diffSeats(imported: SeatChips, roomSeats: readonly number[]): SeatDiff {
  const imp = Object.keys(imported).map(Number).sort((a, b) => a - b);
  const room = [...roomSeats].sort((a, b) => a - b);
  return {
    matched: imp.filter((s) => room.includes(s)),
    onlyImported: imp.filter((s) => !room.includes(s)),
    onlyRoom: room.filter((s) => !imp.includes(s)),
  };
}

/**
 * How to resolve seat differences between an import and a room:
 * - `missing`: chips for occupied room seats absent from the import —
 *   'starting' gives them the configured starting stack, 'zero' seats them with 0 (out).
 * Imported seats without a player are always dropped (shown in the preview).
 */
export interface ImportResolution {
  missing: 'starting' | 'zero';
}

export function resolveImport(
  imported: SeatChips,
  roomSeats: readonly number[],
  startingChips: number,
  resolution: ImportResolution | null,
): { ok: true; chips: SeatChips } | { ok: false; error: 'RESOLUTION_REQUIRED' } {
  const diff = diffSeats(imported, roomSeats);
  const hasDiff = diff.onlyImported.length > 0 || diff.onlyRoom.length > 0;
  if (hasDiff && !resolution) return { ok: false, error: 'RESOLUTION_REQUIRED' };
  const chips: SeatChips = {};
  for (const s of roomSeats) {
    if (s in imported) chips[s] = imported[s];
    else chips[s] = resolution?.missing === 'starting' ? startingChips : 0;
  }
  return { ok: true, chips };
}
