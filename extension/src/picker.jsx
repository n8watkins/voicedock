// The voice picker, the same in the popup and on the settings page: engine
// pills choose the engine, and the list below shows that engine's voices with
// search, a language filter, favorites first and a sample button per voice.
// An engine that can't read shows its status on its pill and offers setup.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { engineLabel, engineUsable, STATUS_SHORT } from './shared.js';
import { NOT_RUNNING_HELP, detectOs } from './setup.js';
import { EngineStatus, Icon } from './ui.jsx';
import { ENGINE_ORDER, filterVoices, languagesIn, voiceKey } from './voices.js';

const PILL_LABEL = { browser: 'Basic' };

export function EnginePills({ engines, value, onChange, ids = ENGINE_ORDER, label = 'Engine' }) {
  return (
    <div className="eng-pills" role="radiogroup" aria-label={label}>
      {ids.map((id) => {
        const state = engines[id]?.state || 'checking';
        const usable = engineUsable(state);
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={value === id}
            className={`eng-pill${usable ? '' : ' off'}`}
            data-engine={id}
            title={`${engineLabel(id)}: ${STATUS_SHORT[state]}`}
            onClick={() => onChange(id)}
          >
            <EngineStatus state={state} variant="dot" />
            <span className="eng-pill-name">{PILL_LABEL[id] || engineLabel(id)}</span>
            {!usable && state !== 'checking' && <span className="eng-pill-state">{STATUS_SHORT[state]}</span>}
          </button>
        );
      })}
    </div>
  );
}

// rows: the whole catalog (src/voices.js); only `engine`'s rows show.
export function VoiceList({
  rows, engine, state, favorites, currentKey, previewKey = '', playing = false,
  onChoose, onFavorite, onPreview, onSetup, autoFocus = false,
}) {
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('');
  const searchRef = useRef(null);
  useEffect(() => { if (autoFocus) searchRef.current?.focus(); }, [autoFocus, engine]);
  useEffect(() => { setQuery(''); setLanguage(''); }, [engine]);

  const engineRows = useMemo(() => rows.filter((r) => r.engine === engine), [rows, engine]);
  const visible = filterVoices(engineRows, { query, language });
  const isFav = (r) => r.id !== '' && favorites.includes(r.id);
  const favs = visible.filter(isFav);
  const rest = visible.filter((r) => !isFav(r));
  const count = engineRows.filter((r) => r.id !== '').length;
  const languages = languagesIn(engineRows);
  const usable = engineUsable(state);

  const row = (r, keyPrefix = '') => (
    <VoiceRow
      key={`${keyPrefix}${voiceKey(r)}`}
      row={r}
      selected={voiceKey(r) === currentKey}
      favorite={isFav(r)}
      previewing={previewKey === voiceKey(r)}
      playing={playing}
      onChoose={onChoose}
      onFavorite={onFavorite}
      onPreview={onPreview}
    />
  );

  if (!usable) {
    return (
      <div className="vl">
        {state === 'checking'
          ? <div className="grp-note"><span>Checking {engineLabel(engine)}…</span><Icon name="loader" size="s" spin /></div>
          : <EngineSetupNote engine={engine} state={state} onSetup={onSetup} />}
      </div>
    );
  }

  return (
    <div className="vl">
      <div className="pk-tools">
        <label className="search">
          <Icon name="search" size="s" />
          <input ref={searchRef} type="search" placeholder={`Search ${count} ${engineLabel(engine)} voice${count === 1 ? '' : 's'}`} aria-label="Search voices" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {languages.length > 1 && (
          <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">All languages</option>
            {languages.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
      </div>
      <div className="pk-list" role="listbox" aria-label={`${engineLabel(engine)} voices`}>
        {favs.length > 0 && (
          <section aria-label="Favorites">
            <div className="grp"><Icon name="star" size="s" /><span>Favorites</span></div>
            {favs.map((r) => row(r, 'fav-'))}
          </section>
        )}
        {rest.length > 0 && (
          <section aria-label={favs.length ? 'All voices' : `${engineLabel(engine)} voices`}>
            {favs.length > 0 && <div className="grp"><Icon name="wave" size="s" /><span>All voices</span></div>}
            {rest.map((r) => row(r))}
          </section>
        )}
        {visible.length === 0 && <div className="grp-note">No voices match.</div>}
      </div>
    </div>
  );
}

// An engine that can't read yet: what its state means and the one action.
export function EngineSetupNote({ engine, state, onSetup }) {
  const missing = state === 'missing';
  const help = NOT_RUNNING_HELP[engine];
  return (
    <div className={`setup-note ${missing ? 'missing' : 'stopped'}`} role="status">
      <EngineStatus state={state} />
      <p>
        {missing
          ? `${engineLabel(engine)} isn't set up on this computer yet.`
          : `${help ? help.means : `${engineLabel(engine)} isn't running.`} ${help ? help.fix[detectOs()] : ''}`}
      </p>
      {onSetup && (
        <button type="button" className="vd-btn primary sm" onClick={() => onSetup(engine)}>
          <Icon name={missing ? 'terminal' : 'power'} size="s" />{missing ? `Set up ${engineLabel(engine)}` : 'How to start'}
        </button>
      )}
    </div>
  );
}

export function VoiceRow({ row, selected, favorite, previewing, playing, onChoose, onFavorite, onPreview }) {
  const canFavorite = row.id !== '';
  return (
    <div
      className="vrow"
      role="option"
      tabIndex={0}
      aria-selected={selected}
      onClick={() => onChoose(row)}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onChoose(row); } }}
    >
      {canFavorite && onFavorite
        ? (
          <button type="button" className={`star${favorite ? ' on' : ''}`} aria-label={favorite ? `Remove ${row.name} from favorites` : `Add ${row.name} to favorites`} aria-pressed={favorite} onClick={(e) => { e.stopPropagation(); onFavorite(row); }}>
            <Icon name="star" size="s" />
          </button>
        )
        : <span className="star-gap" aria-hidden="true" />}
      <span className="vtext">
        <span className="nm">{row.name}{selected && <Icon name="check" size="s" className="sel" />}</span>
        <span className="mt">{row.meta}</span>
      </span>
      {row.tag ? <span className="vd-tag">{row.tag}</span> : <span />}
      {onPreview
        ? (
          <button
            type="button"
            className={`pv${previewing ? ' on' : ''}${previewing && playing ? ' live' : ''}`}
            aria-label={previewing ? `Stop the ${row.name} sample` : `Play a sample of ${row.name}`}
            title={previewing ? 'Stop' : 'Play a sample'}
            onClick={(e) => { e.stopPropagation(); onPreview(row); }}
          >
            <Icon name={previewing ? 'stop' : 'play'} size="s" />
          </button>
        )
        : <span />}
    </div>
  );
}
