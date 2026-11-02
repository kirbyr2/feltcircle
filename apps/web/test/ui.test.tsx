// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GAME_CATALOG, type RoomView } from '@feltcircle/game-protocol';
import { LOCALES, loaders } from '@feltcircle/i18n';
import { I18nProvider, createI18n, switchLocale, useI18n } from '../src/lib/i18n';
import { GameSelect } from '../src/screens/GameSelect';
import { HAND_CATEGORIES, HAND_RULES, HandRankingsDialog } from '../src/components/HandRankings';
import { MuteButton, SoundSettings } from '../src/components/Sound';
import { DEFAULT_SOUND_PREFS, SOUND_KEY, loadSoundPrefs, saveSoundPrefs } from '../src/lib/sound';
import { soundEvents } from '../src/lib/sound-events';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

const renderUi = (ui: ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

describe('game selection', () => {
  it('offers Texas Hold’em and shows Riichi Mahjong as Coming Soon (disabled)', () => {
    const onSelect = vi.fn();
    renderUi(<GameSelect mode="local" onSelect={onSelect} />);
    const texas = screen.getByText("Texas Hold'em").closest('button')!;
    const mahjong = screen.getByText('Riichi Mahjong').closest('button')!;
    expect(texas.disabled).toBe(false);
    expect(mahjong.disabled).toBe(true);
    expect(mahjong.textContent).toContain('Coming Soon');
    fireEvent.click(mahjong);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(texas);
    expect(onSelect).toHaveBeenCalledWith('texas-holdem');
  });

  it('uses the same catalog in both modes', () => {
    for (const mode of ['local', 'online'] as const) {
      const { container, unmount } = renderUi(<GameSelect mode={mode} onSelect={() => {}} />);
      const ids = [...container.querySelectorAll('[data-game]')].map((b) => b.getAttribute('data-game'));
      expect(ids).toEqual(GAME_CATALOG.map((g) => g.id));
      unmount();
    }
  });
});

describe('hand rankings guide', () => {
  it('shows the ten categories with five example cards each, plus the rules', () => {
    renderUi(<HandRankingsDialog onClose={() => {}} />);
    const rows = document.querySelectorAll('.hand-row');
    expect(rows).toHaveLength(10);
    for (const row of rows) expect(row.querySelectorAll('.pcard')).toHaveLength(5);
    expect(screen.getByText('Royal Flush')).toBeTruthy();
    expect(screen.getByText('High Card')).toBeTruthy();
    expect(document.querySelectorAll('ul.help li')).toHaveLength(HAND_RULES.length);
  });

  it('is fully translated in every language (offline bundles)', async () => {
    const keys = ['hands.title', 'hands.intro', 'hands.rulesTitle', 'hands.note', ...HAND_CATEGORIES.flatMap((h) => [`hands.${h.id}.name`, `hands.${h.id}.desc`]), ...HAND_RULES.map((r) => `hands.rule.${r}`)];
    for (const { code } of LOCALES) {
      const messages = await loaders[code]();
      for (const k of keys) expect(messages[k], `${code} ${k}`).toBeTruthy();
    }
  });
});

describe('sound preferences', () => {
  it('defaults to enabled at a moderate volume', () => {
    expect(loadSoundPrefs()).toEqual(DEFAULT_SOUND_PREFS);
    expect(DEFAULT_SOUND_PREFS.enabled).toBe(true);
    expect(DEFAULT_SOUND_PREFS.volume).toBeGreaterThan(0.3);
    expect(DEFAULT_SOUND_PREFS.volume).toBeLessThan(0.8);
  });

  it('saves per device and ignores invalid stored values', () => {
    saveSoundPrefs({ enabled: false, volume: 0.25 });
    expect(loadSoundPrefs()).toEqual({ enabled: false, volume: 0.25 });
    saveSoundPrefs({ enabled: true, volume: 7 });
    expect(loadSoundPrefs().volume).toBe(1);
    localStorage.setItem(SOUND_KEY, '{"enabled":"yes","volume":-3}');
    expect(loadSoundPrefs()).toEqual(DEFAULT_SOUND_PREFS);
    localStorage.setItem(SOUND_KEY, 'not json');
    expect(loadSoundPrefs()).toEqual(DEFAULT_SOUND_PREFS);
  });

  it('mute button and settings update the saved preferences', () => {
    renderUi(
      <>
        <MuteButton />
        <SoundSettings />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(JSON.parse(localStorage.getItem(SOUND_KEY)!).enabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeTruthy();
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '30' } });
    expect(JSON.parse(localStorage.getItem(SOUND_KEY)!)).toEqual({ enabled: true, volume: 0.3 });
  });
});

describe('sound events', () => {
  const view = (version: number, number: number, log: Array<{ type: string; allIn?: boolean }>, phase = 'preflop') =>
    ({ id: 'ROOM1', version, game: { hand: { number, phase, log: log.map((e) => ({ seat: 1, street: 'preflop', ...e })) } } }) as unknown as RoomView;

  it('plays nothing on the first view or when the same state is received again (reconnect)', () => {
    const v = view(5, 1, [{ type: 'sb' }, { type: 'bb' }, { type: 'raise' }]);
    expect(soundEvents(null, v)).toEqual([]);
    expect(soundEvents(v, v)).toEqual([]);
    expect(soundEvents(v, view(4, 1, []))).toEqual([]);
  });

  it('plays sounds for newly confirmed events only', () => {
    const a = view(5, 1, [{ type: 'sb' }, { type: 'bb' }]);
    expect(soundEvents(a, view(6, 1, [{ type: 'sb' }, { type: 'bb' }, { type: 'call' }]))).toEqual(['call']);
    expect(soundEvents(a, view(6, 1, [{ type: 'sb' }, { type: 'bb' }, { type: 'raise', allIn: true }]))).toEqual(['allin']);
    expect(soundEvents(a, view(6, 1, [{ type: 'sb' }, { type: 'bb' }, { type: 'fold' }, { type: 'win' }], 'complete'))).toEqual(['fold', 'win', 'hand']);
    expect(soundEvents(view(9, 1, [], 'complete'), view(10, 2, [{ type: 'sb' }, { type: 'bb' }]))).toEqual(['blind']);
  });
});

describe('localization', () => {
  it('switches language at runtime through react-i18next', async () => {
    const instance = createI18n();
    function Probe() {
      const { t, setPersonal } = useI18n();
      return (
        <>
          <span data-testid="title">{t('games.title')}</span>
          <span data-testid="param">{t('join.requestSent', { seat: 4 })}</span>
          <button onClick={() => setPersonal('ja')}>ja</button>
        </>
      );
    }
    render(
      <I18nProvider instance={instance}>
        <Probe />
      </I18nProvider>,
    );
    await act(async () => switchLocale(instance, 'en'));
    expect(screen.getByTestId('title').textContent).toBe('Choose a game');
    expect(screen.getByTestId('param').textContent).toContain('4');
    await act(async () => {
      fireEvent.click(screen.getByText('ja'));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId('title').textContent).toBe('ゲームを選択');
    expect(screen.getByTestId('param').textContent).toContain('シート 4');
    expect(localStorage.getItem('fc.lang')).toContain('ja');
    expect(document.documentElement.lang).toBe('ja');
  });
});
