import { useMemo, useState } from 'react';
import { diffSeats, encodeChips, encodeChipsJson, parseChips, resolveImport, type ImportResolution, type SeatChips } from '@feltcircle/chip-export';
import { useI18n } from '../lib/i18n';
import { copyText } from '../lib/format';
import { Modal, useToast } from './ui';

export function ExportDialog({ chips, duringHand, onClose }: { chips: SeatChips; duringHand: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [json, setJson] = useState(false);
  const text = json ? encodeChipsJson(chips) : encodeChips(chips);
  return (
    <Modal title={t('export.title')} onClose={onClose}>
      <p className="muted small">{t('export.desc')}</p>
      {duringHand && <p className="warn small">{t('export.duringHand')}</p>}
      <textarea className="code" readOnly value={text} rows={json ? 4 : 2} onFocus={(e) => e.target.select()} />
      <div className="row gap">
        <button className="btn" onClick={() => setJson(!json)}>
          {json ? t('export.compact') : t('export.json')}
        </button>
        <button
          className="btn btn-gold btn-big"
          onClick={async () => {
            if (await copyText(text)) toast(t('common.copied'));
          }}
        >
          {t('common.copy')}
        </button>
      </div>
    </Modal>
  );
}

export interface ImportTarget {
  /** Occupied seats with display names (empty for a brand-new local game). */
  seats: { seat: number; name: string }[];
  startingChips: number;
  /** Administrative reset of a running game (extra confirmation). */
  admin: boolean;
  /** Import is currently impossible (e.g. a hand is in progress). */
  blockedReason?: string;
}

export function ImportDialog({ target, onApply, onClose }: { target: ImportTarget; onApply: (seats: SeatChips, resolution: ImportResolution | null) => Promise<boolean> | boolean; onClose: () => void }) {
  const { t, n } = useI18n();
  const [text, setText] = useState('');
  const [missing, setMissing] = useState<ImportResolution['missing'] | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => (text.trim() ? parseChips(text) : null), [text]);
  const roomSeats = target.seats.map((s) => s.seat);
  const newGame = target.seats.length === 0;
  const diff = parsed?.ok && !newGame ? diffSeats(parsed.state.seats, roomSeats) : null;
  const needsResolution = !!diff && diff.onlyRoom.length > 0;
  const resolved = parsed?.ok
    ? newGame
      ? { ok: true as const, chips: parsed.state.seats }
      : resolveImport(parsed.state.seats, roomSeats, target.startingChips, needsResolution ? (missing ? { missing } : null) : { missing: 'zero' })
    : null;
  const funded = resolved?.ok ? Object.values(resolved.chips).filter((c) => c > 0).length : 0;
  const canApply = !!resolved?.ok && funded >= 2 && (!target.admin || ack) && !target.blockedReason && !busy;

  return (
    <Modal title={t('import.title')} onClose={onClose}>
      {target.blockedReason && <p className="warn">{target.blockedReason}</p>}
      <label className="field">
        <span>{t('import.paste')}</span>
        <textarea className="code" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="FC1 1=2000 2=2000 T=4000" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      </label>
      {parsed && !parsed.ok && <p className="error">{t(`import.err.${parsed.error}`)}</p>}
      {parsed?.ok && (
        <>
          <div className="panel-title">{t('import.preview')}</div>
          <table className="preview">
            <thead>
              <tr>
                <th>{t('import.seat')}</th>
                {!newGame && <th>{t('import.player')}</th>}
                <th className="num">{t('import.chips')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(parsed.state.seats).map(([s, c]) => {
                const seat = Number(s);
                const who = target.seats.find((x) => x.seat === seat);
                return (
                  <tr key={s} className={!newGame && !who ? 'dim' : ''}>
                    <td>{seat}</td>
                    {!newGame && <td>{who ? who.name : t('import.noPlayer')}</td>}
                    <td className="num">{n(c)}</td>
                  </tr>
                );
              })}
              <tr className="total">
                <td>{t('import.total')}</td>
                {!newGame && <td />}
                <td className="num">{n(parsed.total)}</td>
              </tr>
            </tbody>
          </table>
          {needsResolution && (
            <div className="resolution">
              <p className="warn small">{t('import.missing', { seats: diff!.onlyRoom.join(', ') })}</p>
              <label className="radio">
                <input type="radio" checked={missing === 'starting'} onChange={() => setMissing('starting')} /> {t('import.missingStarting')} ({n(target.startingChips)})
              </label>
              <label className="radio">
                <input type="radio" checked={missing === 'zero'} onChange={() => setMissing('zero')} /> {t('import.missingZero')}
              </label>
            </div>
          )}
          {resolved?.ok && funded < 2 && <p className="error">{t('import.onlyOne')}</p>}
          {target.admin && (
            <label className="radio warn">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('import.adminWarning')}
            </label>
          )}
        </>
      )}
      <div className="row gap">
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="btn btn-gold btn-big"
          disabled={!canApply}
          onClick={async () => {
            if (!parsed?.ok) return;
            setBusy(true);
            const ok = await onApply(parsed.state.seats, needsResolution && missing ? { missing } : null);
            setBusy(false);
            if (ok) onClose();
          }}
        >
          {t('import.apply')}
        </button>
      </div>
    </Modal>
  );
}
