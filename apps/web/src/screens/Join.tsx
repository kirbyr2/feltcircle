import { useState } from 'react';
import { parseRoomCode } from '@feltcircle/game-protocol';
import { useI18n } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Brand } from '../components/ui';

export function JoinCode() {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [err, setErr] = useState(false);
  const submit = () => {
    const id = parseRoomCode(code);
    if (!id) return setErr(true);
    navigate(`room/${id}`);
  };
  return (
    <div className="screen setup">
      <div className="row between">
        <button className="btn btn-small" onClick={() => navigate('')}>
          ‹ {t('common.back')}
        </button>
        <Brand small />
      </div>
      <h2 className="gold-text">{t('join.title')}</h2>
      <label className="field">
        <span>{t('join.code')}</span>
        <input
          className="code-input"
          autoFocus
          maxLength={7}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t('join.codePlaceholder')}
          value={code}
          onChange={(e) => {
            setErr(false);
            setCode(e.target.value.toUpperCase());
          }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </label>
      {err && <p className="error small">{t('join.invalidCode')}</p>}
      <button className="btn btn-gold btn-big btn-block" onClick={submit}>
        {t('join.find')}
      </button>
    </div>
  );
}
