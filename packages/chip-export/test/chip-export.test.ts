import { describe, expect, it } from 'vitest';
import { diffSeats, encodeChips, encodeChipsJson, parseChips, resolveImport } from '../src/index.js';

describe('chip export', () => {
  const seats = { 1: 2500, 2: 1750, 3: 3200, 4: 550 };

  it('encodes compactly with a checksum', () => {
    expect(encodeChips(seats)).toBe('FC1 1=2500 2=1750 3=3200 4=550 T=8000');
  });

  it('round-trips both encodings', () => {
    for (const text of [encodeChips(seats), encodeChipsJson(seats)]) {
      const r = parseChips(text);
      expect(r.ok && r.state.seats).toEqual(seats);
    }
  });

  it('accepts the illustrative JSON shape and flexible separators', () => {
    expect(parseChips('{"version":1,"seats":{"1":2500,"2":1750}}').ok).toBe(true);
    const r = parseChips('fc1  1=10,\n2=20;3:0');
    expect(r.ok && r.state.seats).toEqual({ 1: 10, 2: 20, 3: 0 });
  });

  it('rejects malformed input', () => {
    const err = (s: string) => {
      const r = parseChips(s);
      return r.ok ? 'OK' : r.error;
    };
    expect(err('')).toBe('EMPTY');
    expect(err('hello')).toBe('UNKNOWN_FORMAT');
    expect(err('FC2 1=10')).toBe('UNSUPPORTED_VERSION');
    expect(err('FC1 0=10')).toBe('INVALID_SEAT');
    expect(err('FC1 11=10')).toBe('INVALID_SEAT');
    expect(err('FC1 x=10')).toBe('INVALID_SEAT');
    expect(err('FC1 1=-5')).toBe('INVALID_CHIPS');
    expect(err('FC1 1=1.5')).toBe('INVALID_CHIPS');
    expect(err('FC1 1=10 1=20')).toBe('DUPLICATE_SEAT');
    expect(err('FC1 1=10 2=20 T=31')).toBe('TOTAL_MISMATCH');
    expect(err('FC1')).toBe('NO_SEATS');
    expect(err('{"version":1,"seats":{"1":10,"1":20}}')).toBe('DUPLICATE_SEAT');
    expect(err('{"version":2,"seats":{"1":10}}')).toBe('UNSUPPORTED_VERSION');
    expect(err('{"version":1,"seats":{"1":"10"}}')).toBe('INVALID_CHIPS');
    expect(err('{"version":1,"seats":[1,2]}')).toBe('UNKNOWN_FORMAT');
    expect(err('{not json')).toBe('UNKNOWN_FORMAT');
  });

  it('never contains identities', () => {
    const text = encodeChips(seats);
    expect(text).toMatch(/^FC1( \d+=\d+)+ T=\d+$/);
  });

  it('diffs and resolves seat differences', () => {
    const imported = { 1: 100, 2: 200, 5: 300 };
    expect(diffSeats(imported, [1, 2, 3])).toEqual({ matched: [1, 2], onlyImported: [5], onlyRoom: [3] });
    expect(resolveImport(imported, [1, 2, 3], 2000, null)).toEqual({ ok: false, error: 'RESOLUTION_REQUIRED' });
    expect(resolveImport(imported, [1, 2, 3], 2000, { missing: 'starting' })).toEqual({ ok: true, chips: { 1: 100, 2: 200, 3: 2000 } });
    expect(resolveImport(imported, [1, 2, 3], 2000, { missing: 'zero' })).toEqual({ ok: true, chips: { 1: 100, 2: 200, 3: 0 } });
    expect(resolveImport({ 1: 5, 2: 6 }, [1, 2], 2000, null)).toEqual({ ok: true, chips: { 1: 5, 2: 6 } });
  });
});
