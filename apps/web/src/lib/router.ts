import { useEffect, useState } from 'react';
import { isLocale, type LocaleCode } from '@feltcircle/i18n';

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  return { path: p.split('/').filter(Boolean), query: new URLSearchParams(q) };
}

/** Hash routing: works on any static host (including GitHub Pages sub-paths) without rewrites. */
export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(path: string, replace = false) {
  const hash = `#/${path.replace(/^\//, '')}`;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Directory of the app (works at a domain root and under sub-paths such as GitHub Pages). */
export function appBaseUrl(): string {
  const path = location.pathname.replace(/[^/]*$/, '');
  return `${location.origin}${path}`;
}

/**
 * Invitation link, e.g. `https://chips.example.org/join/CFW27?lang=zh-CN`. A
 * tiny script in index.html (and 404.html for static hosts) turns `/join/CODE`
 * into the app's `#/join/CODE` route (query included), so the link works on
 * any host. `server` is added when the backend lives on a different origin
 * than the web app. `lang` is the sharer's language at the moment of sharing;
 * it only sets the recipient's interface language. Never put tokens here.
 */
export function inviteUrl(roomId: string, server: string | null, lang?: LocaleCode | null): string {
  const q = new URLSearchParams();
  if (server) q.set('server', server);
  if (lang && isLocale(lang)) q.set('lang', lang);
  const qs = q.toString();
  return `${appBaseUrl()}join/${roomId}${qs ? `?${qs}` : ''}`;
}

/**
 * Read the `lang` parameter of an opened invitation once and remove it from
 * the address bar, so it is not reapplied on later renders or reloads and a
 * language the recipient picks afterwards sticks. Looks in the hash route's
 * query (`#/join/CODE?lang=de`, what index.html produces) and in the real
 * query string (`/?lang=de#/join/CODE`). Other parameters (`server`) are kept.
 * Returns the language only when it is a supported locale.
 */
export function takeInviteLanguage(): LocaleCode | null {
  let found: string | null = null;
  let changed = false;
  let hash = location.hash;
  const qi = hash.indexOf('?');
  if (qi >= 0) {
    const q = new URLSearchParams(hash.slice(qi + 1));
    if (q.has('lang')) {
      found = q.get('lang');
      q.delete('lang');
      const rest = q.toString();
      hash = hash.slice(0, qi) + (rest ? `?${rest}` : '');
      changed = true;
    }
  }
  let search = location.search;
  const sq = new URLSearchParams(search);
  if (sq.has('lang')) {
    found ??= sq.get('lang');
    sq.delete('lang');
    const rest = sq.toString();
    search = rest ? `?${rest}` : '';
    changed = true;
  }
  if (changed) history.replaceState(history.state, '', `${location.pathname}${search}${hash}`);
  return isLocale(found) ? found : null;
}
