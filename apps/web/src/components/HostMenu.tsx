import { useEffect, useState } from 'react';
import { confirmedChips } from '@feltcircle/room-core';
import { useI18n } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useGame } from './game-context';
import { BlindsDialog, HelpDialog, HistoryDialog, SettingsDialog } from './Dialogs';
import { ExportDialog, ImportDialog } from './ChipDialogs';
import { HandRankingsDialog } from './HandRankings';
import { Confirm, Modal, NumberField } from './ui';

type Sub = null | 'blinds' | 'export' | 'import' | 'players' | 'end' | 'delete' | 'history' | 'help' | 'discard' | 'settings' | 'hands' | 'requests' | { transfer: number };

/** Menu for every player; host-only items appear for the host (and always in Local Mode). */
export function GameMenu({ onClose, onDiscardLocal }: { onClose: () => void; onDiscardLocal?: () => void }) {
  const ctx = useGame();
  const { room, isHost, local, send, mySeat, name } = ctx;
  const { t } = useI18n();
  const [sub, setSub] = useState<Sub>(null);
  const g = room.game;
  const hand = g?.hand;
  const betweenHands = !hand || hand.phase === 'complete';
  const chips = confirmedChips(g);
  const close = () => setSub(null);
  const run = async (p: Promise<boolean>) => {
    if (await p) onClose();
  };

  if (sub === 'blinds')
    return (
      <BlindsDialog
        room={room}
        onClose={close}
        onApply={async (v) => {
          const ok = await send({ type: 'host:setBlinds', blinds: v });
          if (ok) onClose();
          return ok;
        }}
      />
    );
  if (sub === 'export' && chips) return <ExportDialog chips={chips} duringHand={!betweenHands} onClose={close} />;
  if (sub === 'import')
    return (
      <ImportDialog
        target={{
          seats: (g?.seats ?? room.seats.map((s) => s.seat)).map((s) => ({ seat: s, name: name(s) })),
          startingChips: room.settings.startingChips,
          admin: room.status !== 'lobby',
          blockedReason: room.status !== 'lobby' && !betweenHands ? t('import.betweenHands') : undefined,
        }}
        onClose={close}
        onApply={async (seats, resolution) => {
          const ok = await send({ type: 'host:import', seats, resolution });
          if (ok) onClose();
          return ok;
        }}
      />
    );
  if (sub === 'history') return <HistoryDialog room={room} onClose={close} />;
  if (sub === 'help') return <HelpDialog onClose={close} />;
  if (sub === 'settings') return <SettingsDialog onClose={close} />;
  if (sub === 'hands') return <HandRankingsDialog onClose={close} />;
  if (sub === 'requests') return <JoinRequestsDialog onClose={close} />;
  if (sub === 'end') return <Confirm title={t('host.endGame')} message={t('host.endConfirm')} danger onCancel={close} onConfirm={() => run(send({ type: 'host:endGame' }))} />;
  if (sub === 'delete')
    return (
      <Confirm
        title={t('host.deleteRoom')}
        message={t('host.deleteConfirm')}
        danger
        onCancel={close}
        onConfirm={async () => {
          if (await send({ type: 'host:deleteRoom' })) navigate('', true);
        }}
      />
    );
  if (sub === 'discard') return <Confirm title={t('host.discardLocal')} message={t('host.discardConfirm')} danger onCancel={close} onConfirm={() => onDiscardLocal?.()} />;
  if (sub && typeof sub === 'object')
    return <Confirm title={t('host.transfer')} message={t('host.transferConfirm', { name: name(sub.transfer) })} onCancel={close} onConfirm={() => run(send({ type: 'host:transfer', seat: sub.transfer }))} />;
  if (sub === 'players') return <PlayersDialog onClose={close} onTransfer={(seat) => setSub({ transfer: seat })} />;

  const playing = room.status === 'playing';
  return (
    <Modal title={isHost ? t('host.menu') : t('common.history')} onClose={onClose}>
      <div className="menu-list">
        <button className="menu-item" onClick={() => setSub('settings')}>
          ⚙ {t('settings.title')}
        </button>
        <button className="menu-item" onClick={() => setSub('hands')}>
          ♠ {t('hands.title')}
        </button>
        {isHost && room.joinRequests.length > 0 && (
          <button className="menu-item gold" onClick={() => setSub('requests')}>
            ⚑ {t('host.requests')} ({room.joinRequests.length})
          </button>
        )}
        {isHost && playing && (
          <button className="menu-item" onClick={() => run(send({ type: room.paused ? 'host:resume' : 'host:pause' }))}>
            {room.paused ? '▶ ' + t('host.resume') : '❚❚ ' + t('host.pause')}
          </button>
        )}
        {isHost && room.canUndo && (
          <button className="menu-item" onClick={() => run(send({ type: 'host:undo' }))}>
            ↶ {t('host.undo')}
          </button>
        )}
        {isHost && playing && (
          <button className="menu-item" onClick={() => setSub('blinds')}>
            ⇧ {t('host.blinds')}
          </button>
        )}
        {(isHost || local) && (
          <button className="menu-item" onClick={() => setSub('players')}>
            ☺ {t('host.players')}
          </button>
        )}
        {chips && (
          <button className="menu-item gold" onClick={() => setSub('export')}>
            ⇪ {t('host.exportChips')}
          </button>
        )}
        {isHost && g && (
          <button className="menu-item" onClick={() => setSub('import')}>
            ⇩ {t('host.importChips')}
          </button>
        )}
        <button className="menu-item" onClick={() => setSub('history')}>
          ☰ {t('common.history')}
        </button>
        <button className="menu-item" onClick={() => setSub('help')}>
          ? {t('common.help')}
        </button>
        {!local && mySeat !== null && !isHost && room.status === 'playing' && (
          <button className="menu-item" onClick={() => run(send({ type: 'setAway', away: !room.seats.find((s) => s.seat === mySeat)?.away }))}>
            {room.seats.find((s) => s.seat === mySeat)?.away ? t('host.sitIn') : t('host.sitOut')}
          </button>
        )}
        {isHost && playing && (
          <button className="menu-item danger" onClick={() => setSub('end')}>
            ■ {t('host.endGame')}
          </button>
        )}
        {isHost && room.status === 'finished' && (
          <button className="menu-item" onClick={() => run(send({ type: 'host:newGame' }))}>
            ↺ {t('host.backToLobby')}
          </button>
        )}
        {isHost && !local && (
          <button className="menu-item danger" onClick={() => setSub('delete')}>
            ✕ {t('host.deleteRoom')}
          </button>
        )}
        {local && (
          <button className="menu-item" onClick={() => navigate('')}>
            ⌂ {t('host.exitLocal')}
          </button>
        )}
        {local && onDiscardLocal && (
          <button className="menu-item danger" onClick={() => setSub('discard')}>
            ✕ {t('host.discardLocal')}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Host approves (with starting chips) or declines late-join requests. */
export function JoinRequestsDialog({ onClose }: { onClose: () => void }) {
  const { room, send, canSend } = useGame();
  const { t } = useI18n();
  const [chips, setChips] = useState<Record<number, number>>({});
  useEffect(() => {
    if (room.joinRequests.length === 0) onClose();
  }, [room.joinRequests.length, onClose]);
  return (
    <Modal title={t('host.requests')} onClose={onClose}>
      <p className="muted small">{t('host.requestsHint')}</p>
      <ul className="player-list">
        {room.joinRequests.map((r) => {
          const amount = chips[r.seat] ?? room.settings.startingChips;
          const tooBig = r.seat > room.settings.maxPlayers;
          return (
            <li key={r.seat}>
              <div className="player-line">
                <span className="seat-no">{r.seat}</span>
                <b>{r.nickname || t('common.player', { n: r.seat })}</b>
              </div>
              <NumberField label={t('host.startingChipsFor')} value={amount} min={1} onChange={(v) => setChips({ ...chips, [r.seat]: v })} />
              <div className="player-actions">
                <button className="btn btn-small btn-gold" disabled={!canSend || tooBig || amount < 1} onClick={() => send({ type: 'host:approveJoin', seat: r.seat, chips: amount })}>
                  ✓ {t('host.approve')}
                </button>
                <button className="btn btn-small" disabled={!canSend} onClick={() => send({ type: 'host:rejectJoin', seat: r.seat })}>
                  ✕ {t('host.reject')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

function ChipEditor({ seat, current, onDone }: { seat: number; current: number; onDone: () => void }) {
  const { send, canSend } = useGame();
  const { t } = useI18n();
  const [v, setV] = useState(current);
  return (
    <div className="chip-editor">
      <NumberField label={t('host.adjustChips')} value={v} min={0} onChange={setV} hint={t('host.adjustHint')} />
      <div className="row gap-s">
        <button className="btn btn-small" onClick={onDone}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-small btn-gold" disabled={!canSend || v === current} onClick={async () => (await send({ type: 'host:setChips', seat, chips: v })) && onDone()}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}

function AddPlayer() {
  const { room, send, canSend } = useGame();
  const { t } = useI18n();
  const free = Array.from({ length: 10 }, (_, i) => i + 1).filter((s) => !room.seats.some((x) => x.seat === s));
  const [seat, setSeat] = useState(free[0] ?? 0);
  const [nickname, setNickname] = useState('');
  const [chips, setChips] = useState(room.settings.startingChips);
  if (free.length === 0) return null;
  return (
    <details className="advanced">
      <summary>＋ {t('host.addPlayer')}</summary>
      <div className="col gap">
        <div className="grid2">
          <label className="field">
            <span>{t('import.seat')}</span>
            <select value={seat} onChange={(e) => setSeat(Number(e.target.value))}>
              {free.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <NumberField label={t('host.startingChipsFor')} value={chips} min={1} onChange={setChips} />
        </div>
        <input maxLength={20} placeholder={t('common.player', { n: seat })} value={nickname} onChange={(e) => setNickname(e.target.value)} />
        <p className="muted small">{t('host.addPlayerHint')}</p>
        <button
          className="btn btn-gold btn-block"
          disabled={!canSend || !free.includes(seat)}
          onClick={async () => {
            if (await send({ type: 'host:addPlayer', seat, nickname, chips })) {
              setNickname('');
              setSeat(free.find((s) => s !== seat) ?? 0);
            }
          }}
        >
          {t('host.addPlayer')}
        </button>
      </div>
    </details>
  );
}

function PlayersDialog({ onClose, onTransfer }: { onClose: () => void; onTransfer: (seat: number) => void }) {
  const { room, local, isHost, send, name } = useGame();
  const { t, n } = useI18n();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [chipsFor, setChipsFor] = useState<number | null>(null);
  const g = room.game;
  const between = !!g && room.status !== 'lobby' && (!g.hand || g.hand.phase === 'complete');
  const admin = isHost || local;
  const highest = Math.max(2, ...room.seats.map((s) => s.seat), ...room.joinRequests.map((r) => r.seat));
  return (
    <Modal title={t('host.players')} onClose={onClose}>
      <ul className="player-list">
        {room.seats.map((s) => (
          <li key={s.seat}>
            <div className="player-line">
              <span className="seat-no">{s.seat}</span>
              {editing === s.seat ? (
                <input
                  autoFocus
                  value={draft}
                  maxLength={20}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={async () => {
                    await send({ type: 'setNickname', nickname: draft, seat: s.seat });
                    setEditing(null);
                  }}
                />
              ) : (
                <b>{name(s.seat)}</b>
              )}
              {room.hostSeat === s.seat && !local && <span className="tag tag-host">{t('common.host')}</span>}
              {!s.connected && <span className="tag tag-off">{t('common.offline')}</span>}
              {s.autoFold && <span className="tag tag-auto">{s.away ? t('common.away') : t('common.autoFold')}</span>}
              {g && <span className="num muted small push">{n(g.chips[s.seat] ?? 0)}</span>}
            </div>
            {chipsFor === s.seat && <ChipEditor seat={s.seat} current={g?.chips[s.seat] ?? 0} onDone={() => setChipsFor(null)} />}
            <div className="player-actions">
              {local && (
                <>
                  <button
                    className="btn btn-small"
                    onClick={() => {
                      setDraft(s.nickname);
                      setEditing(s.seat);
                    }}
                  >
                    {t('host.rename')}
                  </button>
                  <button className="btn btn-small" onClick={() => send({ type: 'setAway', seat: s.seat, away: !s.away })}>
                    {s.away ? t('host.sitIn') : t('host.sitOut')}
                  </button>
                </>
              )}
              {admin && between && chipsFor !== s.seat && (
                <button className="btn btn-small" onClick={() => setChipsFor(s.seat)}>
                  ± {t('host.adjustChips')}
                </button>
              )}
              {!local && isHost && s.seat !== room.hostSeat && (
                <button className="btn btn-small" onClick={() => onTransfer(s.seat)}>
                  {t('host.transfer')}
                </button>
              )}
              {!local && isHost && !s.connected && !s.autoFold && room.status === 'playing' && (
                <button className="btn btn-small btn-danger" onClick={() => send({ type: 'host:forceFold', seat: s.seat })}>
                  {t('host.forceFold')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {admin && g && !between && <p className="muted small">{t('host.adjustHint')}</p>}
      {local && <AddPlayer />}
      {!local && isHost && (
        <NumberField
          label={t('setup.maxPlayers')}
          value={room.settings.maxPlayers}
          min={highest}
          max={10}
          hint={t('host.tableSizeHint')}
          onChange={(maxPlayers) => maxPlayers !== room.settings.maxPlayers && void send({ type: 'host:setSettings', settings: { maxPlayers } })}
        />
      )}
    </Modal>
  );
}
