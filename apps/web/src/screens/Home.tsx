import { useState } from 'react';
import type { BackendStatus } from '@feltcircle/game-session';
import { encodeChips, type SeatChips } from '@feltcircle/chip-export';
import { useI18n } from '../lib/i18n';
import { navigate } from '../lib/router';
import { getServerOverride, lastRoom, setServerOverride, validServerUrl } from '../lib/backend';
import { Brand, LanguageSelect, Modal } from '../components/ui';
import { ImportDialog } from '../components/ChipDialogs';
import { HelpDialog, SettingsDialog } from '../components/Dialogs';
import { HandRankingsDialog } from '../components/HandRankings';

interface Props {
  backend: BackendStatus;
  onRetry: () => void;
  hasLocalGame: boolean;
  importedChips: SeatChips | null;
  setImportedChips: (c: SeatChips | null) => void;
}

export function Home({ backend, onRetry, hasLocalGame, importedChips, setImportedChips }: Props) {
  const { t } = useI18n();
  const [importing, setImporting] = useState(false);
  const [server, setServer] = useState(false);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  const [hands, setHands] = useState(false);
  const online = backend.state === 'available';
  const rejoin = online ? lastRoom() : null;

  return (
    <div className="screen home">
      <div className="home-top">
        <LanguageSelect compact />
        <button className="icon-btn" onClick={() => setSettings(true)} aria-label={t('settings.title')}>
          ⚙
        </button>
        <button className="icon-btn" onClick={() => setHelp(true)} aria-label={t('common.help')}>
          ?
        </button>
      </div>
      <Brand />

      {importedChips && (
        <div className="card import-ready">
          <div className="muted small">{t('setup.importActive')}</div>
          <code className="code-inline">{encodeChips(importedChips)}</code>
          <button className="btn btn-small" onClick={() => setImportedChips(null)}>
            {t('setup.removeImport')}
          </button>
        </div>
      )}

      <section className="card mode-card">
        <div className="mode-head">
          <span className="mode-icon" aria-hidden>
            ◉
          </span>
          <div>
            <h2>{t('home.local')}</h2>
            <p className="muted small">{t('home.localDesc')}</p>
          </div>
        </div>
        <div className="col gap-s">
          {hasLocalGame && !importedChips && (
            <button className="btn btn-gold btn-big btn-block" onClick={() => navigate('local')}>
              {t('home.resumeLocal')}
            </button>
          )}
          <button className={`btn btn-block ${hasLocalGame && !importedChips ? '' : 'btn-gold btn-big'}`} onClick={() => navigate('games/local')}>
            {t('home.newLocal')}
          </button>
        </div>
      </section>

      <section className={`card mode-card ${online ? '' : 'disabled'}`} aria-disabled={!online}>
        <div className="mode-head">
          <span className="mode-icon" aria-hidden>
            ⇄
          </span>
          <div>
            <h2>{t('home.online')}</h2>
            <p className="muted small">{t('home.onlineDesc')}</p>
          </div>
        </div>
        {backend.state === 'checking' && <p className="muted small">{t('home.checking')}</p>}
        {backend.state === 'unavailable' && (
          <div className="row between">
            <p className="muted small">{t('home.unavailable')}</p>
            <button className="btn btn-small" onClick={onRetry}>
              ↻ {t('home.retry')}
            </button>
          </div>
        )}
        <div className="col gap-s">
          {rejoin && (
            <button className="btn btn-gold btn-block" onClick={() => navigate(`room/${rejoin.roomId}`)}>
              {t('home.resumeOnline', { code: rejoin.roomId })}
            </button>
          )}
          <div className="row gap-s">
            <button className={`btn btn-block ${online ? 'btn-gold' : ''}`} disabled={!online} onClick={() => navigate('games/online')}>
              {t('home.createRoom')}
            </button>
            <button className="btn btn-block" disabled={!online} onClick={() => navigate('join')}>
              {t('home.joinRoom')}
            </button>
          </div>
        </div>
      </section>

      <div className="row gap-s center">
        <button className="btn" onClick={() => setImporting(true)}>
          ⇩ {t('home.importChips')}
        </button>
        <button className="btn" onClick={() => setHands(true)}>
          ♠ {t('hands.title')}
        </button>
        <button className="btn" onClick={() => setServer(true)}>
          ⇄ {t('home.server')}
        </button>
      </div>

      {importing && (
        <ImportDialog
          target={{ seats: [], startingChips: 0, admin: false }}
          onClose={() => setImporting(false)}
          onApply={(seats) => {
            setImportedChips(seats);
            return true;
          }}
        />
      )}
      {server && (
        <ServerDialog
          onClose={() => setServer(false)}
          onSaved={() => {
            setServer(false);
            onRetry();
          }}
        />
      )}
      {help && <HelpDialog onClose={() => setHelp(false)} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
      {hands && <HandRankingsDialog onClose={() => setHands(false)} />}
    </div>
  );
}

function ServerDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(getServerOverride() ?? '');
  const valid = value.trim() === '' || validServerUrl(value.trim());
  return (
    <Modal title={t('home.server')} onClose={onClose}>
      <label className="field">
        <span>{t('home.server')}</span>
        <input type="url" inputMode="url" placeholder="https://chips.example.com" value={value} onChange={(e) => setValue(e.target.value)} autoCapitalize="off" autoCorrect="off" />
        <small className="muted">{t('home.serverHint')}</small>
      </label>
      {!valid && <p className="error small">{t('home.serverInvalid')}</p>}
      <div className="row gap">
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="btn btn-gold"
          disabled={!valid}
          onClick={() => {
            setServerOverride(value.trim() || null);
            onSaved();
          }}
        >
          {t('common.save')}
        </button>
      </div>
    </Modal>
  );
}
