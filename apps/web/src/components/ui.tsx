import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LOCALES, type LocaleCode } from '@feltcircle/i18n';
import { useI18n } from '../lib/i18n';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const { t } = useI18n();
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Confirm({ title, message, onConfirm, onCancel, danger }: { title: string; message: string; onConfirm: () => void; onCancel: () => void; danger?: boolean }) {
  const { t } = useI18n();
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="muted">{message}</p>
      <div className="row gap">
        <button className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-gold'}`} onClick={onConfirm}>
          {t('common.confirm')}
        </button>
      </div>
    </Modal>
  );
}

export function NumberField({ label, value, onChange, min = 0, max, step = 1, hint }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; hint?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (s: string) => {
    const n = Math.floor(Number(s));
    if (!Number.isFinite(n)) return setText(String(value));
    const clamped = Math.max(min, max !== undefined ? Math.min(max, n) : n);
    setText(String(clamped));
    onChange(clamped);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input inputMode="numeric" pattern="[0-9]*" value={text} min={min} max={max} step={step} onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))} onBlur={(e) => commit(e.target.value)} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LanguageSelect({ compact }: { compact?: boolean }) {
  const { locale, setPersonal, t } = useI18n();
  return (
    <label className={compact ? 'lang-compact' : 'field'}>
      {!compact && <span>{t('settings.language')}</span>}
      <select aria-label={t('settings.language')} value={locale} onChange={(e) => setPersonal(e.target.value as LocaleCode)}>
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

const ToastCtx = createContext<(text: string, kind?: 'info' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = next.current++;
    setToasts((ts) => [...ts.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast toast-${x.kind}`}>
            {x.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center-col">
      <div className="spinner" aria-hidden />
      {label && <p className="muted">{label}</p>}
    </div>
  );
}

export function Brand({ small }: { small?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={`brand ${small ? 'brand-small' : ''}`}>
      <div className="brand-mark" aria-hidden>
        <span />
      </div>
      <div>
        <h1>{t('app.name')}</h1>
        {!small && <p>{t('app.tagline')}</p>}
      </div>
    </div>
  );
}
