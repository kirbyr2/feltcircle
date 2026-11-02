import { useEffect, useRef, useState } from 'react';
import { confirmedChips } from '@feltcircle/room-core';
import { useI18n } from '../lib/i18n';
import { formatDuration } from '../lib/format';
import { navigate } from '../lib/router';
import { useGame } from '../components/game-context';
import { Table } from '../components/Table';
import { ActionPanel } from '../components/ActionPanel';
import { HandResultPanel, NoHandPanel, PreActions, ShowdownPanel, StreetPanel, WaitingPanel } from '../components/Panels';
import { GameMenu } from '../components/HostMenu';
import { ExportDialog } from '../components/ChipDialogs';
import { HandRankingsDialog } from '../components/HandRankings';
import { MuteButton, useGameSounds } from '../components/Sound';
import { JoinRequestsDialog } from '../components/HostMenu';

function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: { release(): Promise<void> } | null = null;
    const request = () =>
      (navigator as unknown as { wakeLock: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock
        .request('screen')
        .then((l) => (lock = l))
        .catch(() => {});
    void request();
    const onVis = () => document.visibilityState === 'visible' && void request();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}

function LevelTimer({ ms, version }: { ms: number | null; version: number }) {
  const { t } = useI18n();
  const received = useRef(Date.now());
  const [, force] = useState(0);
  useEffect(() => {
    received.current = Date.now();
  }, [version, ms]);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (ms === null) return null;
  const left = ms - (Date.now() - received.current);
  return <span className="muted small">{t('game.nextLevel', { time: formatDuration(left) })}</span>;
}

export function ConnectionBadge() {
  const { snap } = useGame();
  const { t } = useI18n();
  if (snap.local) return null;
  const label = snap.connection === 'online' ? t('conn.online') : snap.connection === 'connecting' ? t('conn.connecting') : t('conn.reconnecting');
  return (
    <span className={`conn conn-${snap.connection}`} title={label}>
      <span className="dot" /> <span className="conn-label">{label}</span>
    </span>
  );
}

export function GameScreen({ onDiscardLocal }: { onDiscardLocal?: () => void }) {
  const ctx = useGame();
  const { room, local, mySeat, isHost, snap, send, canSend } = ctx;
  const { t, n } = useI18n();
  const [menu, setMenu] = useState(false);
  const [hands, setHands] = useState(false);
  const [requests, setRequests] = useState(false);
  useGameSounds(room);
  const g = room.game!;
  const hand = g.hand;
  const level = g.config.levels[g.levelIndex];
  const myTurn = !local && hand?.phase === 'betting' && hand.toAct === mySeat;
  useWakeLock(room.status === 'playing');
  useEffect(() => {
    if (myTurn && 'vibrate' in navigator) navigator.vibrate?.(120);
  }, [myTurn, hand?.number, hand?.street]);

  const host = room.hostSeat !== null ? room.seats.find((s) => s.seat === room.hostSeat) : undefined;
  const canClaim = !local && mySeat !== null && !isHost && (!host || !host.connected);
  const inHand = !!hand && mySeat !== null && hand.seats.some((s) => s.seat === mySeat);

  let bottom: React.ReactNode;
  if (room.status === 'finished') bottom = <FinishedPanel />;
  else if (!hand) bottom = <NoHandPanel />;
  else if (room.paused)
    bottom = (
      <div className="panel">
        <div className="panel-title">❚❚ {t('game.paused')}</div>
        {isHost && (
          <button className="btn btn-gold btn-big btn-block" disabled={!canSend} onClick={() => send({ type: 'host:resume' })}>
            {t('host.resume')}
          </button>
        )}
      </div>
    );
  else if (hand.phase === 'betting') {
    if (local) bottom = <ActionPanel seat={hand.toAct!} />;
    else if (myTurn) bottom = <ActionPanel seat={mySeat!} />;
    else if (inHand) bottom = <PreActions seat={mySeat!} />;
    else bottom = <WaitingPanel />;
  } else if (hand.phase === 'street-complete') {
    bottom = (
      <>
        <StreetPanel />
        {!local && inHand && !isHost && <PreActions seat={mySeat!} />}
      </>
    );
  } else if (hand.phase === 'showdown') bottom = <ShowdownPanel />;
  else bottom = <HandResultPanel />;

  return (
    <div className="game">
      <header className="game-top">
        <div className="game-info">
          {hand && <span className="hand-no">{t('game.hand', { n: hand.number })}</span>}
          <span className="blinds">{t('game.blinds', { sb: n(level.sb), bb: n(level.bb) })}</span>
          <LevelTimer ms={room.nextLevelInMs} version={room.version} />
        </div>
        <div className="row gap-s">
          <ConnectionBadge />
          {!local && <span className="room-chip">{room.id}</span>}
          <MuteButton />
          <button className="icon-btn" onClick={() => setHands(true)} aria-label={t('hands.title')} title={t('hands.title')}>
            ♠
          </button>
          <button className="icon-btn menu-btn" onClick={() => setMenu(true)} aria-label={t('host.menu')}>
            ☰
          </button>
        </div>
      </header>
      {!local && snap.connection !== 'online' && <div className="banner banner-warn">{t('conn.disabled')}</div>}
      {canClaim && (
        <div className="banner">
          <span>{t('host.claimHint')}</span>
          <button className="btn btn-small btn-gold" disabled={!canSend} onClick={() => send({ type: 'claimHost' })}>
            {t('host.claim')}
          </button>
        </div>
      )}
      {isHost && room.joinRequests.length > 0 && (
        <div className="banner">
          <span>{t('host.requestBanner', { count: room.joinRequests.length })}</span>
          <button className="btn btn-small btn-gold" onClick={() => setRequests(true)}>
            {t('host.review')}
          </button>
        </div>
      )}
      {!local && mySeat !== null && hand && !inHand && hand.phase !== 'complete' && room.status === 'playing' && (
        <div className="banner">{t('game.nextHandJoin')}</div>
      )}
      <Table />
      <div className="bottom">{bottom}</div>
      {menu && <GameMenu onClose={() => setMenu(false)} onDiscardLocal={onDiscardLocal} />}
      {hands && <HandRankingsDialog onClose={() => setHands(false)} />}
      {requests && <JoinRequestsDialog onClose={() => setRequests(false)} />}
    </div>
  );
}

function FinishedPanel() {
  const { room, isHost, local, send, name, canSend } = useGame();
  const { t, n } = useI18n();
  const [exp, setExp] = useState(false);
  const g = room.game!;
  const chips = confirmedChips(g)!;
  const standings = Object.entries(chips)
    .map(([s, c]) => [Number(s), c] as const)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="panel finished">
      <div className="trophy" aria-hidden>
        ♛
      </div>
      <h2 className="gold-text">{t('finished.title')}</h2>
      <p>{g.finished && g.winner !== null ? t('finished.winner', { name: name(g.winner) }) : t('finished.ended')}</p>
      <div className="panel-title">{t('finished.standings')}</div>
      <ul className="standings">
        {standings.map(([s, c]) => (
          <li key={s}>
            <span>
              <span className="seat-no">{s}</span> {name(s)}
            </span>
            <b>{n(c)}</b>
          </li>
        ))}
      </ul>
      <div className="col gap">
        <button className="btn btn-gold btn-block" onClick={() => setExp(true)}>
          {t('host.exportChips')}
        </button>
        {isHost && (
          <button className="btn btn-block" disabled={!canSend} onClick={() => send({ type: 'host:newGame' })}>
            {local ? t('finished.newGame') : t('host.backToLobby')}
          </button>
        )}
        <button className="btn btn-block" onClick={() => navigate('')}>
          {t('finished.home')}
        </button>
      </div>
      {exp && <ExportDialog chips={chips} duringHand={false} onClose={() => setExp(false)} />}
    </div>
  );
}
