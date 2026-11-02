/**
 * Browser end-to-end tests (multi-device sessions). Requires a built web app
 * (`npm run build:web`) and a local Chrome/Chromium; skipped otherwise.
 * Set CHROME_PATH to choose the browser, E2E_SHOTS=<dir> to save screenshots.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { loadConfig } from '../apps/server-node/src/config.js';
import { startServer, type RunningServer } from '../apps/server-node/src/server.js';

const DIST = path.resolve(__dirname, '../apps/web/dist');
const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  (p) => p && fs.existsSync(p),
);
const SHOTS = process.env.E2E_SHOTS;
const enabled = !!CHROME && fs.existsSync(path.join(DIST, 'index.html')) && process.env.SKIP_E2E !== '1';

let server: RunningServer;
let browser: Browser;
let base: string;

async function phone(locale = 'en-US'): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    throw e;
  });
  return { ctx, page };
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

describe.skipIf(!enabled)('browser end-to-end', () => {
  beforeAll(async () => {
    const { chromium } = await import('playwright-core');
    server = await startServer(loadConfig({ PORT: '0', DB_FILE: ':memory:', STATIC_DIR: DIST }), { log: () => {} });
    base = `http://127.0.0.1:${server.port}/`;
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('local mode: full hand on one device, export chips', async () => {
    const { ctx, page } = await phone();
    await page.goto(base);
    await page.click('text=New local game');
    await page.waitForSelector('[data-game="riichi-mahjong"][disabled]');
    await shot(page, 'game-select');
    await page.click('[data-game="texas-holdem"]');
    await page.fill('input[inputmode=numeric] >> nth=0', '3');
    await page.locator('input[inputmode=numeric] >> nth=0').blur();
    await page.click('text=Start game');
    await page.waitForSelector('.table-felt');
    // 3 players: D=1 SB=2 BB=3, seat 1 acts first
    await page.click('.action-row >> text=Raise');
    await page.fill('.amount-input', '100');
    await page.locator('.amount-input').blur();
    await page.click('text=Raise to 100');
    await page.click('.action-row >> text=Fold'); // seat 2
    await page.click('.action-row >> text=Call 80'); // seat 3
    await page.click('text=Cards dealt — continue');
    await page.click('.action-row >> text=Check'); // seat 3
    await page.click('.action-row >> text=Check'); // seat 1
    await page.click('text=Cards dealt — continue');
    await page.click('.action-row >> text=Check');
    await page.click('.action-row >> text=Check');
    await page.click('text=Cards dealt — continue');
    await page.click('.action-row >> text=Check');
    await page.click('.action-row >> text=Check');
    await page.waitForSelector('text=Showdown');
    await shot(page, 'local-showdown');
    await page.click('.chip-btn >> text=Player 3');
    await page.click('text=Award pots');
    await page.waitForSelector('text=Player 3 wins 210');
    await shot(page, 'local-result');
    await page.click('.menu-btn');
    await page.click('text=Export Chips');
    const text = await page.locator('textarea.code').inputValue();
    expect(text).toBe('FC1 1=1900 2=1990 3=2110 T=6000');
    await shot(page, 'local-export');
    // Persisted in IndexedDB: reloading resumes the game, and Home offers to resume it.
    await page.reload();
    await page.waitForSelector('text=Next hand');
    await page.goto(base);
    await page.click('text=Resume local game');
    await page.waitForSelector('text=Next hand');
    await ctx.close();
  }, 60_000);

  it('online: create, invite, join, play, reconnect, independent languages', async () => {
    const host = await phone();
    const guest = await phone('fr-FR');
    await host.page.goto(base);
    await host.page.waitForSelector('button:has-text("Create room"):not([disabled])');
    await shot(host.page, 'online-home');
    await host.page.click('text=Create room');
    await host.page.click('[data-game="texas-holdem"]');
    await host.page.fill('input[placeholder="Player 1"]', 'Hana');
    await host.page.click('button:has-text("Create room")');
    await host.page.waitForSelector('.room-code-big');
    const code = (await host.page.locator('.room-code-big').innerText()).trim();
    expect(code).toMatch(/^[A-Z2-9]{5}$/);
    await host.page.waitForSelector('img.qr');
    await shot(host.page, 'online-lobby-host');

    // Guest opens the invitation URL (what the QR code contains). Browser language is French.
    await guest.page.goto(`${base}join/${code}`);
    await guest.page.waitForSelector('.seat-ring .ring-free');
    await guest.page.fill('.field input', 'Guy');
    await shot(guest.page, 'online-seatpicker');
    // Circular picker: seat 1 (the host) at the top, seat 3 is the second free seat.
    await guest.page.click('.ring-free >> nth=1');
    await guest.page.waitForSelector('.lobby .seat-ring .ring-me');
    expect(await guest.page.locator('.ring-me .seat-no').innerText()).toBe('3');
    await host.page.waitForSelector('text=Guy');
    await shot(guest.page, 'online-lobby-guest');
    // The waiting room keeps the original numbers (1 and 3) and explains the renumbering.
    expect(await host.page.locator('.lobby .ring-taken .seat-no').allInnerTexts()).toEqual(['1', '3']);
    await host.page.waitForSelector('text=renumbered without gaps');

    // Guest switches personal language to Japanese; host stays English.
    await guest.page.selectOption('.lobby select >> nth=-1', 'ja');
    await guest.page.waitForSelector('text=待合室');
    expect(await host.page.locator('text=Waiting room').count()).toBe(1);

    await host.page.click('text=Start game');
    await host.page.waitForSelector('.table-felt');
    await guest.page.waitForSelector('.table-felt');
    // Seats are renumbered without gaps: the guest (waiting-room seat 3) plays as seat 2,
    // on both phones, and only seated players are shown around the table.
    await guest.page.waitForFunction(() => document.querySelector('.seat-me .seat-no')?.textContent === '2');
    expect(await host.page.locator('.table-wrap .seat .seat-no').allInnerTexts()).toEqual(['1', '2']);
    // Heads-up: host (seat 1) is dealer/SB and acts first.
    await host.page.click('.action-row >> text=Call 10');
    await guest.page.waitForSelector('.action-row');
    await guest.page.waitForTimeout(350); // let the panel fade-in finish
    await shot(guest.page, 'online-guest-turn-ja');
    await guest.page.click('.action-row >> nth=0 >> button >> nth=1'); // check
    await host.page.click('text=Cards dealt — continue');
    // Post-flop: big blind (guest, now seat 2) first. Host pre-selects Check/Fold.
    await host.page.click('text=Check / Fold');
    await guest.page.click('.action-row >> button >> nth=2'); // bet
    await guest.page.click('.quick-row >> button >> nth=2'); // pot
    await shot(guest.page, 'online-guest-slider');
    await guest.page.click('.slider-panel .btn-gold');
    // Host's pre-action folds automatically.
    await host.page.waitForSelector('text=Next hand');
    await shot(host.page, 'online-host-result');
    const chips = await host.page.evaluate(() => [...document.querySelectorAll('.seat-stack')].map((e) => e.textContent));
    expect(chips).toEqual(['1,980', '2,020']);

    // Hand rankings guide is available during the game.
    await host.page.click('.icon-btn:has-text("♠")');
    await host.page.waitForSelector('.hand-row >> nth=9');
    await shot(host.page, 'hand-rankings');
    await host.page.click('.modal-head .icon-btn');

    // Late join: a third player asks for a seat after the game started; the host approves.
    const late = await phone('de-DE');
    await late.page.goto(`${base}join/${code}`);
    await late.page.waitForSelector('.note');
    await late.page.fill('.field input', 'Lena');
    await late.page.click('.ring-free >> nth=0'); // first free seat after renumbering: 3
    await late.page.waitForSelector('text=Waiting for the host');
    await host.page.click('.banner >> text=Review');
    await shot(host.page, 'late-join-approve');
    await host.page.click('button:has-text("Approve")');
    await late.page.waitForSelector('.table-felt');
    await host.page.waitForSelector('text=Lena');

    // Guest reloads: reconnects to the renumbered seat with the stored token.
    await guest.page.reload();
    await guest.page.waitForSelector('.table-felt');
    expect(await guest.page.locator('.seat-me .seat-name').innerText()).toBe('Guy');
    expect(await guest.page.locator('.seat-me .seat-no').innerText()).toBe('2');
    expect(await late.page.locator('.seat-me .seat-no').innerText()).toBe('3');
    await host.page.click('text=Next hand');
    // Hand 2 has three players: the late joiner is dealt in.
    await late.page.waitForSelector('.seat-me');
    await guest.page.waitForSelector('.table-felt');
    await shot(guest.page, 'online-guest-hand2');
    await shot(late.page, 'late-join-seated');
    expect(await host.page.locator('.seat-stack').count()).toBe(3);
    await late.ctx.close();
    await host.ctx.close();
    await guest.ctx.close();
  }, 90_000);

  it('circular seat layout: no overlap or overflow at every table size, on phones and desktop', async () => {
    const viewports = [
      { name: 'phone', width: 390, height: 844, mobile: true },
      { name: 'small-phone', width: 320, height: 640, mobile: true },
      { name: 'desktop', width: 1280, height: 800, mobile: false },
    ];
    const LONG = 'Maximiliane-Annabel'; // close to the 20-character nickname limit
    for (let max = 2; max <= 10; max++) {
      const res = await fetch(`${base}api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ game: 'texas-holdem', settings: { maxPlayers: max }, nickname: LONG }),
      });
      const { roomId } = (await res.json()) as { roomId: string };
      for (const vp of viewports) {
        for (const lang of ['en', 'de']) {
          const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile });
          await ctx.addInitScript((l) => localStorage.setItem('fc.lang', l), lang);
          const page = await ctx.newPage();
          page.on('pageerror', (e) => {
            throw e;
          });
          await page.goto(`${base}join/${roomId}`);
          await page.waitForSelector('.seat-ring .ring-slot');
          const report = await page.evaluate(() => {
            const ring = document.querySelector('.seat-ring')!.getBoundingClientRect();
            const slots = [...document.querySelectorAll<HTMLElement>('.ring-slot')].map((el) => el.getBoundingClientRect());
            const overlaps: string[] = [];
            slots.forEach((a, i) =>
              slots.forEach((b, j) => {
                if (j > i && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps.push(`${i + 1}/${j + 1}`);
              }),
            );
            const outside = slots.filter((r) => r.left < ring.left - 0.5 || r.right > ring.right + 0.5 || r.top < ring.top - 0.5 || r.bottom > ring.bottom + 0.5).length;
            const offscreen = slots.filter((r) => r.left < 0 || r.right > window.innerWidth).length;
            // Text must fit its card (nicknames are ellipsised, labels wrap to two lines).
            const overflow = [...document.querySelectorAll<HTMLElement>('.ring-seat')].filter(
              (el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
            ).length;
            const small = [...document.querySelectorAll<HTMLElement>('button.ring-seat')].filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width < 44 || r.height < 44;
            }).length;
            const pageOverflow = document.documentElement.scrollWidth > window.innerWidth;
            return { count: slots.length, overlaps, outside, offscreen, overflow, small, pageOverflow };
          });
          const where = `${max} seats, ${vp.name}, ${lang}`;
          expect(report.count, where).toBe(max);
          expect(report.overlaps, where).toEqual([]);
          expect(report.outside, where).toBe(0);
          expect(report.offscreen, where).toBe(0);
          expect(report.overflow, where).toBe(0);
          expect(report.small, where).toBe(0);
          expect(report.pageOverflow, where).toBe(false);
          if (lang === 'en') await shot(page, `seats-${vp.name}-${max}`);
          await ctx.close();
        }
      }
    }
  }, 240_000);
});
