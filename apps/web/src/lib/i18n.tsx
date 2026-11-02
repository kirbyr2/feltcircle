import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import i18next, { type i18n as I18nInstance } from 'i18next';
import { I18nextProvider, initReactI18next, useTranslation } from 'react-i18next';
import { DEFAULT_LOCALE, english, isLocale, loaders, matchLocale, type LocaleCode, type Params } from '@feltcircle/i18n';
import { lsGet, lsSet } from './storage';
import { takeInviteLanguage } from './router';

const LANG_KEY = 'fc.lang';

/**
 * Translation runtime: react-i18next with the locale JSON files from
 * `@feltcircle/i18n` (stable flat keys such as `action.fold`, `{name}`
 * placeholders). Locales are bundled with the app and loaded lazily; no
 * runtime translation service is used.
 */
export function createI18n(): I18nInstance {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    resources: { [DEFAULT_LOCALE]: { translation: english } },
    keySeparator: false,
    nsSeparator: false,
    interpolation: { prefix: '{', suffix: '}', escapeValue: false },
    react: { useSuspense: false },
    initAsync: false,
    returnNull: false,
  });
  return instance;
}

/** Make sure a locale's messages are registered, then switch to it. */
export async function switchLocale(instance: I18nInstance, locale: LocaleCode): Promise<void> {
  if (!instance.hasResourceBundle(locale, 'translation')) {
    try {
      instance.addResourceBundle(locale, 'translation', await loaders[locale]());
    } catch {
      /* fall back to English */
    }
  }
  await instance.changeLanguage(locale);
}

function browserLocale(): LocaleCode {
  return matchLocale(navigator.languages ?? [navigator.language]) ?? DEFAULT_LOCALE;
}

/** The player's saved language on this device, if any. */
function savedLocale(): LocaleCode | null {
  const v = lsGet(LANG_KEY);
  return isLocale(v) ? v : null;
}

/**
 * Language to show first, so it can be loaded before the first render (no
 * flash of English when opening an invitation): the invitation's language,
 * then the saved choice, then the browser language.
 */
export function initialLocale(inviteLocale: LocaleCode | null): LocaleCode {
  return inviteLocale ?? savedLocale() ?? browserLocale();
}

interface Prefs {
  personal: LocaleCode | null;
  setPersonal(l: LocaleCode | null): void;
  setRoomDefault(l: string | null): void;
  locale: LocaleCode;
}

const PrefsCtx = createContext<Prefs | null>(null);

/**
 * Language precedence: the language of the invitation this visit was opened
 * with (`lang` in the link, `inviteLocale`) > the player's own choice (saved on
 * this device) > the room's default language > the browser language >
 * English. The invitation language lasts for this visit only and ends as soon
 * as the player picks a language. Changing it only affects this screen; it
 * never touches the game, the room settings or other players.
 */
export function I18nProvider({ children, instance, inviteLocale = null }: { children: ReactNode; instance?: I18nInstance; inviteLocale?: LocaleCode | null }) {
  const i18n = useMemo(() => instance ?? createI18n(), [instance]);
  const [visit, setVisit] = useState<LocaleCode | null>(inviteLocale);
  const [personal, setPersonalState] = useState<LocaleCode | null>(savedLocale);
  const [roomDefault, setRoomDefaultState] = useState<LocaleCode | null>(null);
  const locale: LocaleCode = visit ?? personal ?? roomDefault ?? browserLocale();

  // An invitation opened while the app is already running (only the hash changes, no reload).
  useEffect(() => {
    const on = () => {
      const l = takeInviteLanguage();
      if (l) setVisit(l);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    void switchLocale(i18n, locale);
    document.documentElement.lang = locale;
  }, [i18n, locale]);

  const setPersonal = useCallback((l: LocaleCode | null) => {
    lsSet(LANG_KEY, l);
    setPersonalState(l);
    setVisit(null); // the player's own choice wins from now on
  }, []);
  const setRoomDefault = useCallback((l: string | null) => setRoomDefaultState(isLocale(l) ? l : null), []);
  const prefs = useMemo(() => ({ personal, setPersonal, setRoomDefault, locale }), [personal, setPersonal, setRoomDefault, locale]);
  return (
    <I18nextProvider i18n={i18n}>
      <PrefsCtx.Provider value={prefs}>{children}</PrefsCtx.Provider>
    </I18nextProvider>
  );
}

interface I18nValue extends Prefs {
  t(key: string, params?: Params): string;
  n(value: number): string;
}

export function useI18n(): I18nValue {
  const { t: tr, i18n } = useTranslation();
  const prefs = useContext(PrefsCtx);
  if (!prefs) throw new Error('I18nProvider missing');
  const lang = (isLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE) as LocaleCode;
  const nf = useMemo(() => new Intl.NumberFormat(lang), [lang]);
  const t = useCallback((key: string, params?: Params) => tr(key, params ?? {}) as string, [tr]);
  const n = useCallback((v: number) => nf.format(v), [nf]);
  return { ...prefs, t, n };
}
