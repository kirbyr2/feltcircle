// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionSnapshot } from '@feltcircle/game-session';
import { loaders } from '@feltcircle/i18n';
import { connectSeat, createOnlineRoom, joinSeat, toView } from '@feltcircle/room-core';
import { I18nProvider, initialLocale, useI18n } from '../src/lib/i18n';
import { appBaseUrl, inviteUrl, takeInviteLanguage } from '../src/lib/router';
import { LanguageSelect } from '../src/components/ui';
import { GameProvider } from '../src/components/game-context';
import { Lobby } from '../src/screens/Room';

// The QR image encodes exactly the text it was given; read it back from the src.
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async (text: string) => `data:image/png;qr,${encodeURIComponent(text)}`) },
}));
const qrText = (container: HTMLElement) => {
  const src = container.querySelector<HTMLImageElement>('img.qr')?.getAttribute('src') ?? '';
  return decodeURIComponent(src.replace('data:image/png;qr,', ''));
};

const LANG_KEY = 'fc.lang';
const goTo = (url: string) => history.replaceState(null, '', url);

beforeEach(() => {
  localStorage.clear();
  goTo('/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (navigator as { share?: unknown }).share;
});

/** The language picker (the only select whose options are the supported locales). */
const langSelect = () =>
  screen.getAllByRole('combobox').find((el) => [...(el as HTMLSelectElement).options].some((o) => o.value === 'zh-CN')) as HTMLSelectElement;

describe('invitation URLs', () => {
  it('keep the existing format and add the sharer’s language', () => {
    const base = appBaseUrl();
    expect(inviteUrl('ABCDE', null)).toBe(`${base}join/ABCDE`);
    expect(inviteUrl('ABCDE', null, 'zh-CN')).toBe(`${base}join/ABCDE?lang=zh-CN`);
    expect(inviteUrl('ABCDE', 'https://chips.example.org', 'de')).toBe(`${base}join/ABCDE?server=https%3A%2F%2Fchips.example.org&lang=de`);
    // Unsupported values are never written into a link.
    expect(inviteUrl('ABCDE', null, 'xx' as never)).toBe(`${base}join/ABCDE`);
  });

  it('the /join/CODE redirect in index.html keeps lang in the hash route', () => {
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    const run = (pathname: string, search: string) => {
      const loc = { pathname, search, replaced: '', replace(u: string) { this.replaced = u; } };
      new Function('location', script)(loc);
      return loc.replaced;
    };
    expect(run('/join/abcde', '?lang=zh-CN')).toBe('/#/join/ABCDE?lang=zh-CN');
    expect(run('/app/join/ABCDE', '?server=https%3A%2F%2Fx.example&lang=ja')).toBe('/app/#/join/ABCDE?server=https%3A%2F%2Fx.example&lang=ja');
    // Old links without lang still work.
    expect(run('/join/ABCDE', '')).toBe('/#/join/ABCDE');
  });
});

describe('reading lang from an opened invitation', () => {
  it('accepts a supported language once and removes it, keeping the route and other parameters', () => {
    goTo('/#/join/ABCDE?server=https%3A%2F%2Fx.example&lang=zh-CN');
    expect(takeInviteLanguage()).toBe('zh-CN');
    expect(location.hash).toBe('#/join/ABCDE?server=https%3A%2F%2Fx.example');
    // Not reapplied later (re-renders, reloads of the same address).
    expect(takeInviteLanguage()).toBe(null);
  });

  it('also reads it from the real query string', () => {
    goTo('/?lang=ja#/join/ABCDE');
    expect(takeInviteLanguage()).toBe('ja');
    expect(location.search).toBe('');
    expect(location.hash).toBe('#/join/ABCDE');
  });

  it('ignores missing and unsupported values', () => {
    goTo('/#/join/ABCDE');
    expect(takeInviteLanguage()).toBe(null);
    expect(location.hash).toBe('#/join/ABCDE');
    for (const bad of ['xx', 'zh', 'EN', '', '<script>']) {
      goTo(`/#/join/ABCDE?lang=${encodeURIComponent(bad)}`);
      expect(takeInviteLanguage(), bad).toBe(null);
      expect(location.hash).toBe('#/join/ABCDE');
    }
  });

  it('room links (#/room/CODE) keep working with and without lang', () => {
    goTo('/#/room/ABCDE');
    expect(takeInviteLanguage()).toBe(null);
    expect(location.hash).toBe('#/room/ABCDE');
    goTo('/#/room/ABCDE?lang=ko');
    expect(takeInviteLanguage()).toBe('ko');
    expect(location.hash).toBe('#/room/ABCDE');
  });
});

/** Shows the active language and one translated string. */
function Probe() {
  const { locale, t } = useI18n();
  return (
    <p data-testid="probe" data-locale={locale}>
      {t('lobby.copyLink')}
    </p>
  );
}
const probe = () => screen.getByTestId('probe');

describe('interface language from an invitation', () => {
  it('overrides a different saved language for this visit, before anything else is chosen', async () => {
    localStorage.setItem(LANG_KEY, 'de');
    expect(initialLocale('ja')).toBe('ja'); // what main.tsx preloads before the first render
    expect(initialLocale(null)).toBe('de');
    const ja = await loaders.ja();
    render(
      <I18nProvider inviteLocale="ja">
        <Probe />
        <LanguageSelect />
      </I18nProvider>,
    );
    expect(probe().dataset.locale).toBe('ja');
    await waitFor(() => expect(probe().textContent).toBe(ja['lobby.copyLink']));
    expect((langSelect()).value).toBe('ja');
    // The saved choice is untouched: the invitation only sets this visit.
    expect(localStorage.getItem(LANG_KEY)).toBe('de');
  });

  it('lets the recipient change language normally afterwards; the invitation is not reapplied', async () => {
    localStorage.setItem(LANG_KEY, 'de');
    const { rerender } = render(
      <I18nProvider inviteLocale="ja">
        <Probe />
        <LanguageSelect />
      </I18nProvider>,
    );
    fireEvent.change(langSelect(), { target: { value: 'fr' } });
    expect(probe().dataset.locale).toBe('fr');
    expect(localStorage.getItem(LANG_KEY)).toBe('fr');
    rerender(
      <I18nProvider inviteLocale="ja">
        <Probe />
        <LanguageSelect />
      </I18nProvider>,
    );
    expect(probe().dataset.locale).toBe('fr');
  });

  it('without a valid invitation language, the saved choice / browser language still apply', () => {
    localStorage.setItem(LANG_KEY, 'es');
    render(
      <I18nProvider inviteLocale={null}>
        <Probe />
      </I18nProvider>,
    );
    expect(probe().dataset.locale).toBe('es');
    cleanup();
    localStorage.clear();
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-BR']);
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(probe().dataset.locale).toBe('pt');
  });

  it('applies an invitation opened while the app is running (hash change only)', () => {
    localStorage.setItem(LANG_KEY, 'de');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(probe().dataset.locale).toBe('de');
    act(() => {
      goTo('/#/join/ABCDE?lang=ko');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(probe().dataset.locale).toBe('ko');
    expect(location.hash).toBe('#/join/ABCDE');
  });
});

describe('sharing from the waiting room', () => {
  function renderLobby(inviteLocale: 'ja' | 'zh-CN' | null) {
    let s = createOnlineRoom({ id: 'SHARE', hostToken: 'secret-host-token', hostNickname: 'Ada', now: 1, settings: { maxPlayers: 4 } });
    s = connectSeat(s, 1, 1);
    s = connectSeat(joinSeat(s, 2, 'Bo', 'secret-guest-token', 1), 2, 1);
    const snapshot: SessionSnapshot = {
      room: toView(s, 2, 1),
      mySeat: 2,
      pendingSeat: null,
      isHost: false,
      local: false,
      connection: 'online',
      pending: false,
      lastError: null,
      gone: null,
    };
    const session = { getSnapshot: () => snapshot, subscribe: () => () => {}, send: async () => ({ ok: true }), dispose() {} };
    return render(
      <I18nProvider inviteLocale={inviteLocale}>
        <GameProvider session={session}>{(ctx) => (ctx ? <Lobby /> : null)}</GameProvider>
      </I18nProvider>,
    );
  }
  const inviteButtons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.invite button')];

  it('copy, native share and QR use the sharer’s current language, and follow language changes', async () => {
    localStorage.setItem(LANG_KEY, 'de'); // the recipient's old choice
    const writeText = vi.fn(async () => {});
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
    // Opened from an invitation in Japanese.
    const { container } = renderLobby('ja');
    const base = appBaseUrl();
    await waitFor(() => expect(qrText(container)).toBe(`${base}join/SHARE?lang=ja`));
    const [copy, shareBtn] = inviteButtons(container);
    await act(async () => fireEvent.click(copy));
    expect(writeText).toHaveBeenLastCalledWith(`${base}join/SHARE?lang=ja`);

    // The recipient switches to Simplified Chinese and shares again: the new choice is used.
    fireEvent.change(langSelect(), { target: { value: 'zh-CN' } });
    await waitFor(() => expect(qrText(container)).toBe(`${base}join/SHARE?lang=zh-CN`));
    await act(async () => fireEvent.click(copy));
    expect(writeText).toHaveBeenLastCalledWith(`${base}join/SHARE?lang=zh-CN`);
    await act(async () => fireEvent.click(shareBtn));
    expect(share).toHaveBeenLastCalledWith(expect.objectContaining({ url: `${base}join/SHARE?lang=zh-CN` }));

    // No private data in any of them.
    for (const text of [qrText(container), ...writeText.mock.calls.map((c) => String((c as unknown[])[0]))]) {
      expect(text).not.toContain('secret');
      expect(text).not.toContain('token');
    }
  });

  it('without an invitation, links carry the sharer’s own saved language', async () => {
    localStorage.setItem(LANG_KEY, 'ru');
    const { container } = renderLobby(null);
    await waitFor(() => expect(qrText(container)).toBe(`${appBaseUrl()}join/SHARE?lang=ru`));
  });
});
