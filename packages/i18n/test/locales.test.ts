import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '../src/index';

const dir = join(__dirname, '..', 'locales');
const load = (code: string): Record<string, string> =>
  JSON.parse(readFileSync(join(dir, `${code}.json`), 'utf8'));
const en = load('en');
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function walk(d: string, out: string[] = []): string[] {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('locales', () => {
  it('has a file for every declared locale', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    expect(files.sort()).toEqual(LOCALES.map((l) => l.code).sort());
  });

  for (const { code } of LOCALES) {
    it(`${code}: same keys and placeholders as en`, () => {
      const loc = load(code);
      expect(Object.keys(loc).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(en)) {
        expect(typeof loc[k], k).toBe('string');
        expect(loc[k].trim().length, k).toBeGreaterThan(0);
        expect(placeholders(loc[k]), `${code}:${k}`).toEqual(placeholders(v));
      }
    });
  }

  it('non-English locales are actually translated', () => {
    for (const { code } of LOCALES) {
      if (code === 'en') continue;
      const loc = load(code);
      const same = Object.keys(en).filter((k) => loc[k] === en[k]).length;
      expect(same / Object.keys(en).length, code).toBeLessThan(0.25);
    }
  });

  it('every literal t() key used by the web app exists', () => {
    const src = join(__dirname, '..', '..', '..', 'apps', 'web', 'src');
    const missing: string[] = [];
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
        if (!(m[1] in en)) missing.push(`${file}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
