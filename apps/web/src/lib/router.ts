import { useEffect, useState } from 'react';

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
 * Invitation link, e.g. `https://chips.example.org/join/CFW27`. A tiny script
 * in index.html (and 404.html for static hosts) turns `/join/CODE` into the
 * app's `#/join/CODE` route, so the link works on any host. `server` is added
 * when the backend lives on a different origin than the web app.
 */
export function inviteUrl(roomId: string, server: string | null): string {
  const q = server ? `?server=${encodeURIComponent(server)}` : '';
  return `${appBaseUrl()}join/${roomId}${q}`;
}
