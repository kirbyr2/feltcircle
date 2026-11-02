import en from '../locales/en.json';

export type Messages = Record<string, string>;
export type TranslationKey = keyof typeof en;
export type Params = Record<string, string | number>;

export const LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
] as const;

export type LocaleCode = (typeof LOCALES)[number]['code'];

export const DEFAULT_LOCALE: LocaleCode = 'en';
export const english: Messages = en;

export function isLocale(x: unknown): x is LocaleCode {
  return typeof x === 'string' && LOCALES.some((l) => l.code === x);
}

/** Lazy loaders so each locale is a separate chunk. */
export const loaders: Record<LocaleCode, () => Promise<Messages>> = {
  en: async () => en,
  'zh-CN': () => import('../locales/zh-CN.json').then((m) => m.default),
  'zh-TW': () => import('../locales/zh-TW.json').then((m) => m.default),
  ja: () => import('../locales/ja.json').then((m) => m.default),
  ko: () => import('../locales/ko.json').then((m) => m.default),
  fr: () => import('../locales/fr.json').then((m) => m.default),
  de: () => import('../locales/de.json').then((m) => m.default),
  es: () => import('../locales/es.json').then((m) => m.default),
  pt: () => import('../locales/pt.json').then((m) => m.default),
  ru: () => import('../locales/ru.json').then((m) => m.default),
};

/** Map browser languages (e.g. `zh-Hant-HK`, `pt-BR`) to a supported locale. */
export function matchLocale(candidates: readonly string[]): LocaleCode | null {
  for (const raw of candidates) {
    const c = raw.toLowerCase();
    if (c.startsWith('zh')) {
      if (/hant|tw|hk|mo/.test(c)) return 'zh-TW';
      return 'zh-CN';
    }
    const base = c.split('-')[0];
    const hit = LOCALES.find((l) => l.code === base);
    if (hit) return hit.code;
  }
  return null;
}

/** Interpolate `{name}` placeholders. Missing keys fall back to English, then to the key. */
export function translate(messages: Messages, key: string, params?: Params): string {
  const template = messages[key] ?? english[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, p: string) => (p in params ? String(params[p]) : m));
}

/** Intl locale tag for number formatting. */
export function intlLocale(code: LocaleCode): string {
  return code;
}
