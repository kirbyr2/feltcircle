import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { ServerSession, type WebSocketLike } from '@feltcircle/game-session';
import { useI18n } from '../lib/i18n';
import { inviteUrl, navigate } from '../lib/router';
import { getServerOverride, rememberRoom, setServerOverride, tokenStore, validServerUrl } from '../lib/backend';
import { copyText } from '../lib/format';
import { GameProvider, useGame } from '../components/game-context';
import { Brand, LanguageSelect, Modal, NumberField, Spinner, useToast } from '../components/ui';
import { ImportDialog } from '../components/ChipDialogs';
import { Advanced, BlindFields, blindsValid, ProgressionFields, type BlindValues } from '../components/Dialogs';
import { SeatRing } from '../components/SeatRing';
import { ConnectionBadge, GameScreen } from './GameScreen';

const sessions = new Map<string, ServerSession>();

/** One live session per backend+room; other rooms are disconnected. */
export function openRoomSession(baseUrl: string, roomId: string): ServerSession {
  const key = `${baseUrl}|${roomId}`;
  let s = sessions.get(key);
  if (s && s.getSnapshot().gone) {
    s.dispose();
    sessions.delete(key);
    s = undefined;
  }
  if (!s) {
    for (const [k, other] of sessions) {
      other.dispose();
      sessions.delete(k);
    }
    s = new ServerSession({ baseUrl, roomId, tokens: tokenStore(baseUrl), createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike });
    sessions.set(key, s);
  }
  return s;
}

if (typeof document !== 'undefined') {
  // Phones suspend background tabs: reconnect as soon as the page is visible again.
  const wake = () => {
    if (document.visibilityState === 'visible') for (const s of sessions.values()) s.reconnectNow();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
}

export function Room({ roomId, defaultBase, unavailable, serverParam }: { roomId: string; defaultBase: string | null; unavailable: boolean; serverParam: string | null }) {
  const { t, setRoomDefault } = useI18n();
  const base = useMemo(() => {
    if (serverParam && validServerUrl(serverParam)) {
      setServerOverride(serverParam);
      return serverParam.replace(/\/$/, '');
    }
    return defaultBase;
  }, [serverParam, defaultBase]);
  const session = useMemo(() => (base ? openRoomSession(base, roomId) : null), [base, roomId]);
  useEffect(() => {
    if (base) rememberRoom(base, roomId);
  }, [base, roomId]);
  useEffect(() => () => setRoomDefault(null), [setRoomDefault]);

  if (!session && unavailable) {
    return (
      <div className="screen center-col">
        <Brand />
        <p className="lead">{t('home.unavailable')}</p>
        <button className="btn btn-gold" onClick={() => navigate('', true)}>
          {t('finished.home')}
        </button>
      </div>
    );
  }
  if (!session) return <Spinner label={t('home.checking')} />;
  return (
    <GameProvider session={session}>
      {(ctx) => {
        const snap = session.getSnapshot();
        if (snap.gone) {
          if (base) rememberRoom(base, null);
          return (
            <div className="screen center-col">
              <Brand />
              <p className="lead">{t(`gone.${snap.gone}`)}</p>
              <button className="btn btn-gold" onClick={() => navigate('', true)}>
                {t('finished.home')}
              </button>
            </div>
          );
        }
        if (!ctx) return <Spinner label={snap.connection === 'reconnecting' ? t('conn.reconnecting') : t('conn.connecting')} />;
        return <RoomContent setRoomDefault={setRoomDefault} />;
      }}
    </GameProvider>
  );
}

function RoomContent({ setRoomDefault }: { setRoomDefault: (l: string | null) => void }) {
  const { room, mySeat } = useGame();
  useEffect(() => setRoomDefault(room.settings.defaultLanguage), [room.settings.defaultLanguage, setRoomDefault]);
  if (mySeat === null) return <SeatPicker />;
  if (room.status === 'lobby') return <Lobby />;
  return <GameScreen />;
}

export function SeatPicker() {
  const { room, session, name, snap } = useGame();
  const { t } = useI18n();
  const toast = useToast();
  const [nickname, setNickname] = useState('');
  // Seat being joined; also blocks duplicate submissions until the server answers.
  const [joining, setJoining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lobby = room.status === 'lobby';
  const rejected = snap.lastError?.code === 'JOIN_REJECTED';
  const online = snap.connection === 'online';
  const join = async (seat: number, takeover: boolean) => {
    if (joining !== null) return;
    setJoining(seat);
    setError(null);
    try {
      const r = await (session as ServerSession).join(seat, nickname, takeover);
      if (!r.ok) {
        const msg = t(`error.${r.error ?? 'INTERNAL'}`);
        setError(msg);
        toast(msg, 'error');
      }
    } finally {
      setJoining(null);
    }
  };
  const seats = Array.from({ length: room.settings.maxPlayers }, (_, i) => i + 1);
  if (snap.pendingSeat !== null) {
    return (
      <div className="screen setup">
        <div className="row between">
          <button className="btn btn-small" onClick={() => navigate('')}>
            ‹ {t('common.back')}
          </button>
          <ConnectionBadge />
        </div>
        <div className="room-code-big">{room.id}</div>
        <div className="card center-col">
          <div className="spinner" aria-hidden />
          <p className="lead">{t('join.requestSent', { seat: snap.pendingSeat })}</p>
          <p className="muted small">{t('join.requestHint')}</p>
        </div>
        <LanguageSelect />
      </div>
    );
  }
  return (
    <div className="screen setup">
      <div className="row between">
        <button className="btn btn-small" onClick={() => navigate('')}>
          ‹ {t('common.back')}
        </button>
        <ConnectionBadge />
      </div>
      <div className="room-code-big">{room.id}</div>
      <h2 className="gold-text">{t('join.chooseSeat')}</h2>
      {!lobby && <p className="note">{t('join.lateJoin')}</p>}
      {rejected && <p className="error small">{t('error.JOIN_REJECTED')}</p>}
      <label className="field">
        <span>{t('join.nickname')}</span>
        <input maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} />
      </label>
      <SeatRing
        seats={seats}
        label={t('join.tableLabel')}
        center={<span className="ring-code">{room.id}</span>}
        renderSeat={(seat) => {
          const s = room.seats.find((x) => x.seat === seat);
          const isJoining = joining === seat;
          if (!s) {
            const requested = room.joinRequests.some((x) => x.seat === seat);
            const label = isJoining ? t('join.joining') : requested ? t('join.requested') : lobby ? t('join.sit') : t('join.request');
            return (
              <button
                className={`ring-seat ring-free ${isJoining ? 'ring-joining' : ''}`}
                disabled={requested || joining !== null || !online}
                aria-busy={isJoining || undefined}
                aria-label={`${lobby ? t('join.sitAria', { seat }) : t('join.requestAria', { seat })}${requested ? ` (${t('join.requested')})` : ''}`}
                onClick={() => join(seat, false)}
              >
                <span className="seat-no">{seat}</span>
                <span className="ring-label">{label}</span>
              </button>
            );
          }
          const host = room.hostSeat === seat;
          const marks = (
            <>
              <span className="ring-top">
                <span className="seat-no">{seat}</span>
                {host && (
                  <span className="tag tag-host" title={t('common.host')}>
                    <span aria-hidden>★</span>
                    <span className="sr-only">{t('common.host')}</span>
                  </span>
                )}
              </span>
              <span className="ring-name">{name(seat)}</span>
            </>
          );
          if (!s.connected) {
            // Reclaim your own seat (e.g. after switching phones): only while it has no live connection.
            return (
              <button
                className={`ring-seat ring-reclaim ${host ? 'ring-host' : ''}`}
                disabled={joining !== null || !online}
                aria-busy={isJoining || undefined}
                aria-label={`${t('join.takeOverAria', { seat, name: name(seat) })}${host ? `, ${t('common.host')}` : ''}`}
                title={t('join.takeOverHint')}
                onClick={() => join(seat, true)}
              >
                {marks}
                <span className="ring-sub">{isJoining ? t('join.joining') : `↺ ${t('join.reclaim')}`}</span>
              </button>
            );
          }
          return (
            <div className={`ring-seat ring-taken ${host ? 'ring-host' : ''}`}>
              {marks}
              <span className="ring-sub">
                <span className="dot on" aria-hidden /> {t('conn.online')}
              </span>
            </div>
          );
        }}
      />
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {lobby && <p className="muted small">{t('lobby.renumberNote')}</p>}
      <p className="muted small">{t('join.takeOverHint')}</p>
      <LanguageSelect />
    </div>
  );
}

/** True when the occupied seats are not 1…n (they will be renumbered when the game starts). */
function hasGaps(occupied: number[]): boolean {
  return occupied.some((seat, i) => seat !== i + 1);
}

function Qr({ text }: { text: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(text, { margin: 1, width: 360, color: { dark: '#0b0b0c', light: '#f4e6b8' }, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [text]);
  return src ? <img className="qr" src={src} alt="QR" width={180} height={180} /> : <div className="qr" />;
}

export function Lobby() {
  const { room, isHost, send, canSend, mySeat, name } = useGame();
  const { t, n, locale } = useI18n();
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'settings' | 'import' | 'nick'>(null);
  const [dealer, setDealer] = useState<number | null>(null);
  const [manage, setManage] = useState<number | null>(null);
  // The sharer's language right now (copy, share and QR all follow language changes).
  const url = inviteUrl(room.id, getServerOverride(), locale);
  const count = room.seats.length;
  const share = async () => {
    const text = `${t('lobby.shareText', { code: room.id })} ${url}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'FeltCircle', text: t('lobby.shareText', { code: room.id }), url });
        return;
      } catch {
        /* cancelled */
      }
    }
    if (await copyText(text)) toast(t('common.copied'));
  };
  const host = room.hostSeat !== null ? room.seats.find((s) => s.seat === room.hostSeat) : undefined;
  return (
    <div className="screen lobby">
      <div className="row between">
        <button className="btn btn-small" onClick={() => navigate('')}>
          ‹
        </button>
        <h2 className="gold-text">{t('lobby.title')}</h2>
        <ConnectionBadge />
      </div>
      <div className="invite card">
        <div className="muted small">{t('lobby.roomCode')}</div>
        <div className="room-code-big">{room.id}</div>
        <Qr text={url} />
        <div className="muted small">{t('lobby.scan')}</div>
        <div className="row gap-s">
          <button
            className="btn btn-small"
            onClick={async () => {
              if (await copyText(url)) toast(t('common.copied'));
            }}
          >
            {t('lobby.copyLink')}
          </button>
          <button className="btn btn-small" onClick={share}>
            {t('common.share')}
          </button>
        </div>
      </div>
      <div className="row between">
        <b>{t('lobby.players', { count, max: room.settings.maxPlayers })}</b>
        <span className="muted small">{t('lobby.available', { n: room.settings.maxPlayers - count })}</span>
      </div>
      <SeatRing
        seats={Array.from({ length: room.settings.maxPlayers }, (_, i) => i + 1)}
        label={t('join.tableLabel')}
        center={<span className="ring-code">{room.id}</span>}
        renderSeat={(seat) => {
          const s = room.seats.find((x) => x.seat === seat);
          if (!s)
            return (
              <div className="ring-seat ring-empty">
                <span className="seat-no">{seat}</span>
                <span className="ring-label">{t('join.free')}</span>
              </div>
            );
          const hostSeat = room.hostSeat === seat;
          const me = seat === mySeat;
          const status = s.connected ? t('conn.online') : t('common.offline');
          const content = (
            <>
              <span className="ring-top">
                <span className="seat-no">{seat}</span>
                {hostSeat && (
                  <span className="tag tag-host" title={t('common.host')}>
                    <span aria-hidden>★</span>
                    <span className="sr-only">{t('common.host')}</span>
                  </span>
                )}
              </span>
              <span className="ring-name">{name(seat)}</span>
              <span className="ring-sub">
                <span className={`dot ${s.connected ? 'on' : 'off'}`} title={status} aria-hidden />{' '}
                {room.pendingImport ? <span className="num">{n(room.pendingImport[seat] ?? 0)}</span> : me ? t('join.yourSeat') : status}
                {(room.pendingImport || me) && <span className="sr-only">, {me ? `${t('join.yourSeat')}, ` : ''}{status}</span>}
              </span>
            </>
          );
          const classes = `ring-seat ring-taken ${hostSeat ? 'ring-host' : ''} ${me ? 'ring-me' : ''}`;
          if (isHost && !hostSeat)
            return (
              <button className={classes} aria-label={`${t('lobby.manageSeat', { seat, name: name(seat) })}, ${status}`} onClick={() => setManage(seat)}>
                {content}
              </button>
            );
          return <div className={classes}>{content}</div>;
        }}
      />
      {room.pendingImport && <p className="note small">{t('lobby.importStaged')}</p>}
      {hasGaps(room.seats.map((x) => x.seat)) && <p className="muted small">{t('lobby.renumberNote')}</p>}
      {!isHost && (!host || !host.connected) && (
        <div className="banner">
          <span>{t('host.claimHint')}</span>
          <button className="btn btn-small btn-gold" onClick={() => send({ type: 'claimHost' })}>
            {t('host.claim')}
          </button>
        </div>
      )}
      {isHost ? (
        <>
          <div className="row gap-s">
            <button className="btn btn-block" onClick={() => setDialog('settings')}>
              ⚙ {t('lobby.settings')}
            </button>
            <button className="btn btn-block" onClick={() => setDialog('import')}>
              ⇩ {t('host.importChips')}
            </button>
          </div>
          <label className="field">
            <span>{t('setup.firstDealer')}</span>
            <select value={dealer ?? room.seats[0]?.seat} onChange={(e) => setDealer(Number(e.target.value))}>
              {room.seats.map((s) => (
                <option key={s.seat} value={s.seat}>
                  {s.seat} · {name(s.seat)}
                </option>
              ))}
            </select>
          </label>
          {count < 2 && <p className="muted small">{t('lobby.needTwo')}</p>}
          <button className="btn btn-gold btn-big btn-block" disabled={count < 2 || !canSend} onClick={() => send({ type: 'host:start', ...(dealer ? { dealerSeat: dealer } : {}) })}>
            {t('lobby.start')}
          </button>
        </>
      ) : (
        <>
          <p className="muted center">{t('lobby.waitingHost')}</p>
          <div className="row gap-s">
            <button className="btn btn-block" onClick={() => setDialog('nick')}>
              {t('host.rename')}
            </button>
            <button className="btn btn-block" onClick={() => send({ type: 'leaveSeat' }).then((ok) => ok && navigate(''))}>
              {t('lobby.leave')}
            </button>
          </div>
        </>
      )}
      {isHost && (
        <button className="btn btn-small" onClick={() => setDialog('nick')}>
          {t('host.rename')}
        </button>
      )}
      <LanguageSelect />
      {manage !== null && room.seats.some((x) => x.seat === manage) && (
        <Modal title={t('join.seatTaken', { seat: manage, name: name(manage) })} onClose={() => setManage(null)}>
          <div className="row gap">
            <button className="btn" onClick={() => setManage(null)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-danger"
              disabled={!canSend}
              onClick={async () => {
                if (await send({ type: 'host:removeSeat', seat: manage })) setManage(null);
              }}
            >
              {t('lobby.remove')}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'settings' && <LobbySettings onClose={() => setDialog(null)} />}
      {dialog === 'nick' && <NicknameDialog onClose={() => setDialog(null)} />}
      {dialog === 'import' && (
        <ImportDialog
          target={{ seats: room.seats.map((s) => ({ seat: s.seat, name: name(s.seat) })), startingChips: room.settings.startingChips, admin: false }}
          onClose={() => setDialog(null)}
          onApply={(seats, resolution) => send({ type: 'host:import', seats, resolution })}
        />
      )}
    </div>
  );
}

function NicknameDialog({ onClose }: { onClose: () => void }) {
  const { room, mySeat, send } = useGame();
  const { t } = useI18n();
  const [v, setV] = useState(room.seats.find((s) => s.seat === mySeat)?.nickname ?? '');
  return (
    <Modal title={t('host.rename')} onClose={onClose}>
      <input maxLength={20} value={v} autoFocus onChange={(e) => setV(e.target.value)} placeholder={t('common.player', { n: mySeat ?? 1 })} />
      <button className="btn btn-gold btn-block" onClick={async () => (await send({ type: 'setNickname', nickname: v })) && onClose()}>
        {t('common.save')}
      </button>
    </Modal>
  );
}

function LobbySettings({ onClose }: { onClose: () => void }) {
  const { room, send } = useGame();
  const { t } = useI18n();
  const s = room.settings;
  const [maxPlayers, setMax] = useState(s.maxPlayers);
  const [chips, setChips] = useState(s.startingChips);
  const [blinds, setBlinds] = useState<BlindValues>({ sb: s.sb, bb: s.bb, progression: s.progression, levelMinutes: s.levelMinutes });
  const minPlayers = Math.max(2, ...room.seats.map((x) => x.seat));
  return (
    <Modal title={t('lobby.settings')} onClose={onClose}>
      <div className="grid2">
        <NumberField label={t('setup.maxPlayers')} value={maxPlayers} min={minPlayers} max={10} onChange={setMax} />
        <NumberField label={t('setup.startingChips')} value={chips} min={1} onChange={setChips} />
      </div>
      <BlindFields value={blinds} onChange={setBlinds} />
      <Advanced>
        <ProgressionFields value={blinds} onChange={setBlinds} />
      </Advanced>
      <button
        className="btn btn-gold btn-block"
        disabled={!blindsValid(blinds)}
        onClick={async () => (await send({ type: 'host:setSettings', settings: { maxPlayers, startingChips: chips, ...blinds } })) && onClose()}
      >
        {t('common.save')}
      </button>
    </Modal>
  );
}
