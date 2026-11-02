/**
 * Smoke test against a running backend (Node or Cloudflare, local or deployed):
 *   FC_LIVE_URL=http://127.0.0.1:8787 npx vitest run tests/live-backend.test.ts
 * Creates one short-lived room, plays a hand, reconnects, and deletes the room.
 * Skipped when FC_LIVE_URL is not set.
 */
import { describe, expect, it } from 'vitest';
import { createRoomRequest, detectBackend, fetchRoomSummary } from '@feltcircle/game-session';
import { client, MemoryTokens, waitFor } from './support.js';

const BASE = process.env.FC_LIVE_URL?.replace(/\/+$/, '');

describe.skipIf(!BASE)('live backend smoke test', () => {
  it('detects, creates, plays, reconnects and deletes', async () => {
    const base = BASE!;
    const detected = await detectBackend(base);
    expect(detected.state).toBe('available');

    const created = await createRoomRequest(base, { settings: { maxPlayers: 4 }, nickname: 'Smoke host' });
    if (!created.ok) throw new Error(created.error);
    const id = created.room.roomId;
    const hostTokens = new MemoryTokens();
    hostTokens.set(id, created.room.token);
    const host = client(base, id, hostTokens);
    const guest = client(base, id);
    try {
      await waitFor(() => host.session.getSnapshot().mySeat === 1, 10000, 'host welcome');
      await waitFor(() => guest.session.getSnapshot().connection === 'online', 10000, 'guest online');
      expect((await guest.session.join(2, 'Smoke guest')).ok).toBe(true);

      expect((await host.session.send({ type: 'host:start' })).ok).toBe(true);
      // Heads-up: seat 1 is button/SB and acts first preflop.
      expect((await host.session.send({ type: 'act', action: { type: 'call' } })).ok).toBe(true);
      // Out-of-turn action is rejected by the server.
      expect((await host.session.send({ type: 'act', action: { type: 'check' } })).ok).toBe(false);
      expect((await guest.session.send({ type: 'act', action: { type: 'raise', amount: 60 } })).ok).toBe(true);
      expect((await host.session.send({ type: 'act', action: { type: 'fold' } })).ok).toBe(true);
      await waitFor(() => guest.session.getSnapshot().room?.game?.hand?.phase === 'complete', 10000, 'hand complete');
      const game = guest.session.getSnapshot().room!.game!;
      expect(game.chips[1]).toBe(1980);
      expect(game.chips[2]).toBe(2020);

      // Reconnect with the stored token and get the same seat + full state back.
      guest.session.dispose();
      const again = client(base, id, guest.tokens);
      await waitFor(() => again.session.getSnapshot().mySeat === 2 && !!again.session.getSnapshot().room, 10000, 'resync');
      expect(again.session.getSnapshot().room!.game!.hand!.number).toBe(1);
      again.session.dispose();

      expect((await host.session.send({ type: 'host:deleteRoom' })).ok).toBe(true);
      const gone = await fetchRoomSummary(base, id);
      expect(gone.ok).toBe(false);
    } finally {
      host.session.dispose();
      guest.session.dispose();
    }
  }, 60000);
});
