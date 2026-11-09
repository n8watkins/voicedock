// The toolbar popup: profiles as pills, what will read ("Reading with"), a
// voice picker across every engine, transport controls, and the dock strip of
// engine statuses.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  APP_NAME,
  defaultProfile,
  engineLabel,
  engineUsable,
  favoritesFor,
  MAX_FAVORITES,
  MAX_PROFILES,
  normalizeProfile,
  runSettingsMigration,
  sentenceLabel,
  STATUS_LABEL,
  voicesUrl,
} from './shared.js';
import { EngineMono, EngineStatus, Icon, useEngines } from './ui.jsx';
import { buildVoiceCatalog, ENGINE_ORDER, filterVoices, languagesIn, rowForProfile, voiceKey } from './voices.js';

const SPEEDS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0, 2.25, 2.5];
const IDLE_PLAYBACK = { isPlaying: false, isPaused: false, progress: null, engine: null };

function fmtRate(rate) {
  const r = Number(rate) || 1;
  return `${Number.isInteger(r * 10) ? r.toFixed(1) : String(Number(r.toFixed(2)))}×`;
}

function stepSpeed(rate, direction) {
  if (direction > 0) return SPEEDS.find((s) => s > rate + 0.001) ?? SPEEDS[SPEEDS.length - 1];
  return [...SPEEDS].reverse().find((s) => s < rate - 0.001) ?? SPEEDS[0];
}

function openSettings(hash = 'settings') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${hash}`) });
  window.close();
}

// Where an engine's "Set up" or "How to start" goes until the Voices &
// Engines page exists: Get started has Piper's setup, Settings has each
// engine's commands.
function setupHash(engine, state) {
  return engine === 'piper' && state === 'missing' ? 'welcome' : 'settings';
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response);
    });
  });
}

function PopupApp() {
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [fallback, setFallback] = useState(true);
  const [favoritesByEngine, setFavoritesByEngine] = useState({});
  const [voiceIds, setVoiceIds] = useState({ piper: [], kokoro: [] });
  const [defaultVoiceByEngine, setDefaultVoiceByEngine] = useState({});
  const [browserVoices, setBrowserVoices] = useState([]);
  const [playback, setPlayback] = useState(IDLE_PLAYBACK);
  const [shortcut, setShortcut] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [readHint, setReadHint] = useState('');
  const [note, setNote] = useState(null); // { tone: 'warn' | 'err', text }
  const [previewKey, setPreviewKey] = useState('');
  const { engines } = useEngines({ pollMs: 3000 });

  const active = profiles.find((p) => p.id === activeId) || profiles[0] || null;
  const engine = active?.engine || 'browser';
  const engineState = engines[engine]?.state || 'checking';

  // ── Load settings, and follow changes made elsewhere ────────────────────
  useEffect(() => {
    let disposed = false;
    (async () => {
      const stored = await runSettingsMigration(chrome.storage.local);
      let list = Array.isArray(stored.profiles) ? stored.profiles.map(normalizeProfile) : [];
      let id = stored.activeId || '';
      if (list.length === 0) {
        const profile = defaultProfile();
        list = [profile];
        id = profile.id;
        await chrome.storage.local.set({ profiles: list, activeId: id });
      }
      if (disposed) return;
      setProfiles(list);
      setActiveId(list.some((p) => p.id === id) ? id : list[0].id);
      setFallback(stored.fallback !== false);
      setFavoritesByEngine(stored.favoritesByEngine || {});
    })();
    const onChanged = (changes, area) => {
      if (area !== 'local') return;
      if (changes.profiles?.newValue) setProfiles(changes.profiles.newValue.map(normalizeProfile));
      if (changes.activeId?.newValue) setActiveId(changes.activeId.newValue);
      if (changes.fallback) setFallback(changes.fallback.newValue !== false);
      if (changes.favoritesByEngine) setFavoritesByEngine(changes.favoritesByEngine.newValue || {});
    };
    chrome.storage.onChanged.addListener(onChanged);
    chrome.commands?.getAll?.().then((commands) => {
      if (!disposed) setShortcut(commands.find((c) => c.name === 'read-selection')?.shortcut || '');
    }).catch(() => {});
    chrome.tts?.getVoices?.().then((voices) => { if (!disposed) setBrowserVoices(voices || []); }).catch(() => {});
    return () => { disposed = true; chrome.storage.onChanged.removeListener(onChanged); };
  }, []);

  // ── Each engine's voices, once it is ready ──────────────────────────────
  const piperReady = engineUsable(engines.piper.state);
  const kokoroReady = engineUsable(engines.kokoro.state);
  const kokoroStandby = engines.kokoro.state === 'standby';
  useEffect(() => {
    let disposed = false;
    for (const [id, ready] of [['piper', piperReady], ['kokoro', kokoroReady]]) {
      if (!ready) continue;
      fetch(voicesUrl(id, engines[id].state)).then((res) => (res.ok ? res.json() : null)).then((data) => {
        if (disposed || !data) return;
        setVoiceIds((prev) => ({ ...prev, [id]: Array.isArray(data.voices) ? data.voices : [] }));
        setDefaultVoiceByEngine((prev) => ({ ...prev, [id]: data.defaultVoice || '' }));
      }).catch(() => {});
    }
    return () => { disposed = true; };
  }, [piperReady, kokoroReady, kokoroStandby]);

  // Warm up: opening the popup on a Kokoro profile starts Kokoro, so the read
  // that usually follows doesn't wait for it.
  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current || engine !== 'kokoro' || engineState !== 'standby') return;
    warmed.current = true;
    chrome.runtime.sendMessage({ type: 'warm-engine', engine: 'kokoro' }).catch?.(() => {});
  }, [engine, engineState]);

  // ── Playback state, while the popup is open ─────────────────────────────
  useEffect(() => {
    const poll = () => chrome.runtime.sendMessage({ type: 'get-playback-state' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      setPlayback(response);
    });
    poll();
    const timer = setInterval(poll, 400);
    return () => clearInterval(timer);
  }, []);
  // A preview ends when the playback it started ends.
  const previewStarted = useRef(false);
  useEffect(() => {
    if (!previewKey) { previewStarted.current = false; return; }
    if (playback.isPlaying) previewStarted.current = true;
    else if (previewStarted.current) setPreviewKey('');
  }, [playback.isPlaying, previewKey]);

  const rows = useMemo(() => buildVoiceCatalog({
    piper: piperReady ? voiceIds.piper : [],
    kokoro: kokoroReady ? voiceIds.kokoro : [],
    browser: browserVoices,
  }), [piperReady, kokoroReady, voiceIds, browserVoices]);
  const current = rowForProfile(rows, active, defaultVoiceByEngine);

  // ── Actions ─────────────────────────────────────────────────────────────
  async function saveProfiles(nextProfiles, nextActiveId = active?.id) {
    setProfiles(nextProfiles);
    setActiveId(nextActiveId);
    await chrome.storage.local.set({ profiles: nextProfiles, activeId: nextActiveId });
  }

  async function selectProfile(id) {
    setActiveId(id);
    setReadHint('');
    await chrome.storage.local.set({ activeId: id });
  }

  async function updateActive(patch) {
    if (!active) return;
    await saveProfiles(profiles.map((p) => (p.id === active.id ? normalizeProfile({ ...p, ...patch }) : p)));
  }

  async function chooseVoice(row) {
    await updateActive({ engine: row.engine, voice: row.id });
    setPickerOpen(false);
  }

  async function toggleFavorite(row) {
    const list = favoritesFor(favoritesByEngine, row.engine);
    let nextList;
    if (list.includes(row.id)) {
      nextList = list.filter((v) => v !== row.id);
    } else {
      if (list.length >= MAX_FAVORITES) {
        setNote({ tone: 'warn', text: `You have ${MAX_FAVORITES} ${engineLabel(row.engine)} favorites. Unstar one to add another.` });
        return;
      }
      nextList = [...list, row.id];
    }
    const next = { ...favoritesByEngine, [row.engine]: nextList };
    setFavoritesByEngine(next);
    await chrome.storage.local.set({ favoritesByEngine: next });
  }

  async function preview(row) {
    const key = voiceKey(row);
    if (previewKey === key) {
      chrome.runtime.sendMessage({ type: 'stop-all' });
      setPreviewKey('');
      return;
    }
    setPreviewKey(key);
    const settings = normalizeProfile({ ...(active || defaultProfile()), engine: row.engine, voice: row.id });
    const response = await sendMessage({ type: 'test-voice', text: `This is ${row.name === 'Automatic' ? 'the Basic voice' : row.name}, reading with ${engineLabel(row.engine)}.`, settings });
    if (response && !response.ok) setNote({ tone: 'err', text: response.error || 'That voice could not play.' });
    else if (response?.fellBack) setNote({ tone: 'warn', text: `${engineLabel(row.engine)} isn't running, so the Basic voice played instead.` });
  }

  async function readSelection() {
    setReadHint('');
    const response = await sendMessage({ type: 'read-active-tab' });
    if (response?.reason === 'no-selection') setReadHint('Select text on the page first');
    else if (response?.reason === 'no-page') setReadHint("VoiceDock can't read this page");
    else if (response && !response.ok) setNote({ tone: 'err', text: response.error || 'Nothing could read that.' });
  }

  function togglePause() {
    chrome.runtime.sendMessage({ type: 'keyboard-pause' });
    setPlayback((p) => ({ ...p, isPaused: !p.isPaused }));
  }

  function stop() {
    chrome.runtime.sendMessage({ type: 'stop-all' });
    setPlayback(IDLE_PLAYBACK);
  }

  function skip(delta) {
    chrome.runtime.sendMessage({ type: 'skip-sentence', delta });
  }

  async function setRate(rate) {
    await updateActive({ rate });
    if (playback.isPlaying) chrome.runtime.sendMessage({ type: 'set-live-rate', rate });
  }

  async function setVolume(volume) {
    await updateActive({ volume });
    if (playback.isPlaying) chrome.runtime.sendMessage({ type: 'set-live-volume', volume });
  }

  async function createProfile(name) {
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (profiles.length >= MAX_PROFILES) {
      setNote({ tone: 'warn', text: `You have ${MAX_PROFILES} profiles, the most VoiceDock keeps. Delete one in Settings first.` });
      return false;
    }
    if (profiles.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      setNote({ tone: 'warn', text: 'A profile with this name already exists.' });
      return false;
    }
    const base = active || defaultProfile();
    const profile = normalizeProfile({ ...base, id: crypto.randomUUID(), name: trimmed });
    await saveProfiles([...profiles, profile], profile.id);
    return true;
  }

  const reading = playback.isPlaying || playback.progress?.active;
  return (
    <div className={`popup${pickerOpen ? ' picker-open' : ''}`}>
      <header className="pp-head">
        <img src="icons/icon48.png" alt="" width="22" height="22" />
        <b>{APP_NAME}</b>
        <button className="vd-icon-btn" type="button" aria-label="Open settings" title="Settings" onClick={() => openSettings('settings')}>
          <Icon name="settings" />
        </button>
      </header>

      <ProfilePills
        profiles={profiles}
        activeId={active?.id}
        onSelect={selectProfile}
        onAdd={() => (profiles.length >= MAX_PROFILES
          ? setNote({ tone: 'warn', text: `You have ${MAX_PROFILES} profiles, the most VoiceDock keeps. Delete one in Settings first.` })
          : setNewProfileOpen(true))}
      />
      {newProfileOpen && <NewProfileForm onSave={createProfile} onClose={() => setNewProfileOpen(false)} />}

      <ReadingWith
        engine={engine}
        state={engineState}
        row={current}
        onOpen={() => setPickerOpen(true)}
      />
      {(engineState === 'stopped' || engineState === 'missing') && (
        <p className="fallback-line" role="status">
          <Icon name="warn" size="s" />
          <span>
            {fallback ? 'The Basic voice reads' : 'Nothing reads'} until {engineLabel(engine)} is ready.{' '}
            <button type="button" className="link-btn" onClick={() => openSettings(setupHash(engine, engineState))}>
              {engineState === 'missing' ? 'Set it up' : 'How to start'}
            </button>
          </span>
        </p>
      )}

      <Transport
        reading={reading}
        playback={playback}
        shortcut={shortcut}
        readHint={readHint}
        onRead={readSelection}
        onTogglePause={togglePause}
        onStop={stop}
        onSkip={skip}
      />

      <div className="tp-row">
        <div className="ctl">
          <span className="k" id="speed-label">Speed</span>
          <div className="stepper" role="group" aria-labelledby="speed-label">
            <button type="button" aria-label="Slower" disabled={!active || (active.rate ?? 1) <= SPEEDS[0]} onClick={() => setRate(stepSpeed(active.rate ?? 1, -1))}><Icon name="chevron-left" size="s" /></button>
            <output aria-live="polite">{fmtRate(active?.rate ?? 1)}</output>
            <button type="button" aria-label="Faster" disabled={!active || (active.rate ?? 1) >= SPEEDS[SPEEDS.length - 1]} onClick={() => setRate(stepSpeed(active.rate ?? 1, 1))}><Icon name="chevron-right" size="s" /></button>
          </div>
        </div>
        <div className="ctl">
          <label className="k" htmlFor="volume">Volume <b>{Math.round((active?.volume ?? 1) * 100)}%</b></label>
          <input id="volume" type="range" min="0" max="200" step="10" value={Math.round((active?.volume ?? 1) * 100)} disabled={!active} onChange={(e) => setVolume(Number(e.target.value) / 100)} />
        </div>
      </div>

      {note && (
        <div className={`pp-note ${note.tone}`} role="alert">
          <Icon name={note.tone === 'err' ? 'alert' : 'warn'} size="s" />
          <span className="msg">{note.text}</span>
          <button type="button" className="vd-icon-btn" aria-label="Dismiss" onClick={() => setNote(null)}><Icon name="close" size="s" /></button>
        </div>
      )}

      <nav className="dock" aria-label="Engines">
        {ENGINE_ORDER.map((id) => (
          <button key={id} type="button" className="dock-cell" onClick={() => openSettings(id === 'browser' ? 'settings' : setupHash(id, engines[id].state))} title={`${engineLabel(id)}: ${STATUS_LABEL[engines[id].state]}`}>
            <span className="dock-name">{id === 'browser' ? 'Basic' : engineLabel(id)}</span>
            <EngineStatus state={engines[id].state} variant="compact" short />
          </button>
        ))}
      </nav>

      {pickerOpen && (
        <VoicePicker
          rows={rows}
          engines={engines}
          favoritesByEngine={favoritesByEngine}
          current={current}
          previewKey={previewKey}
          playing={playback.isPlaying && !playback.isPaused}
          onChoose={chooseVoice}
          onFavorite={toggleFavorite}
          onPreview={preview}
          onSetup={(id) => openSettings(setupHash(id, engines[id].state))}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function ProfilePills({ profiles, activeId, onSelect, onAdd }) {
  return (
    <div className="profiles" role="group" aria-label="Profiles">
      {profiles.map((p) => (
        <button key={p.id} type="button" className="profile" aria-pressed={p.id === activeId} onClick={() => onSelect(p.id)}>
          {p.name}
        </button>
      ))}
      <button type="button" className="profile add" aria-label="New profile" title="New profile" onClick={onAdd}>
        <Icon name="plus" size="s" />
      </button>
    </div>
  );
}

function NewProfileForm({ onSave, onClose }) {
  const [name, setName] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  async function save() {
    if (!name.trim()) { ref.current?.focus(); return; }
    if (await onSave(name)) onClose();
  }
  return (
    <form className="new-profile" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input
        ref={ref}
        type="text"
        maxLength={40}
        placeholder="New profile name, e.g. Audiobooks"
        aria-label="New profile name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
      />
      <button type="submit" className="vd-btn primary sm">Add</button>
      <button type="button" className="vd-icon-btn" aria-label="Cancel" onClick={onClose}><Icon name="close" size="s" /></button>
    </form>
  );
}

function ReadingWith({ engine, state, row, onOpen }) {
  const ready = engineUsable(state);
  const where = row.meta;
  return (
    <button type="button" className={`reading${state === 'stopped' || state === 'missing' ? ' warn' : ''}`} aria-haspopup="dialog" onClick={onOpen}>
      <EngineMono engine={engine} />
      <span className="rd-text">
        <span className="lbl">Reading with</span>
        <span className="name">{row.engine === 'browser' && !row.id ? 'Basic voice' : row.name}</span>
        <span className="sub">
          {engine === 'browser' && !row.id ? 'Built into this computer' : (
            <>
              {engineLabel(engine)}
              {state === 'checking' ? null : ready
                ? (where ? <> · {where}</> : null)
                : <> · <EngineStatus state={state} variant="compact" /></>}
            </>
          )}
        </span>
      </span>
      <Icon name="chevron-down" className="rd-chev" />
    </button>
  );
}

function Transport({ reading, playback, shortcut, readHint, onRead, onTogglePause, onStop, onSkip }) {
  const progress = playback.progress;
  const audible = playback.isPlaying && !playback.isPaused && (progress?.current || 0) > 0;
  const percent = progress?.total ? Math.round(Math.min(1, (progress.current || 0) / progress.total) * 100) : 0;
  if (!reading) {
    return (
      <div className="transport">
        <div className="tp-main">
          <button type="button" className="play-big" aria-label="Read selection" onClick={onRead}><Icon name="play" /></button>
          <div className="tp-text">
            <b>Read selection</b>
            {playback.starting
              ? <span role="status">Starting {engineLabel(playback.starting)}, about 5 s</span>
              : readHint
                ? <span className="hint-warn">{readHint}</span>
                : <span>Select text, then {shortcut ? <>press <Keys combo={shortcut} /></> : 'press play'}</span>}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="transport">
      <div className="tp-main">
        <button type="button" className={`play-big${audible ? ' live' : ''}`} aria-label={playback.isPaused ? 'Resume' : 'Pause'} onClick={onTogglePause}>
          <Icon name={playback.isPaused ? 'play' : 'pause'} />
        </button>
        <div className="tp-text">
          <b>{playback.isPaused ? 'Paused' : 'Reading'}</b>
          <span>{sentenceLabel(progress)}</span>
        </div>
        <button type="button" className="vd-icon-btn" aria-label="Previous sentence" title="Previous sentence" onClick={() => onSkip(-1)}><Icon name="skip-back" /></button>
        <button type="button" className="vd-icon-btn" aria-label="Next sentence" title="Next sentence" onClick={() => onSkip(1)}><Icon name="skip-forward" /></button>
        <button type="button" className="vd-icon-btn" aria-label="Stop" title="Stop" onClick={onStop}><Icon name="stop" size="s" /></button>
      </div>
      <div className="progress" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Keys({ combo }) {
  const parts = combo.split('+');
  return (
    <span className="vd-keys">
      {parts.map((k, i) => <React.Fragment key={k}>{i > 0 && '+'}<kbd>{k}</kbd></React.Fragment>)}
    </span>
  );
}

function VoicePicker({ rows, engines, favoritesByEngine, current, previewKey, playing, onChoose, onFavorite, onPreview, onSetup, onClose }) {
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('');
  const searchRef = useRef(null);
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isFav = (row) => row.id !== '' && favoritesFor(favoritesByEngine, row.engine).includes(row.id);
  const visible = filterVoices(rows, { query, language });
  const filtering = Boolean(query.trim() || language);
  const favorites = visible.filter((r) => isFav(r) && engineUsable(engines[r.engine]?.state));
  const total = rows.filter((r) => !(r.engine === 'browser' && r.id === '')).length;
  const currentKey = voiceKey(current);

  const row = (r) => (
    <VoiceRow
      key={voiceKey(r)}
      row={r}
      selected={voiceKey(r) === currentKey}
      favorite={isFav(r)}
      previewing={previewKey === voiceKey(r)}
      playing={playing}
      showEngine={false}
      onChoose={onChoose}
      onFavorite={onFavorite}
      onPreview={onPreview}
    />
  );

  const groups = [];
  if (favorites.length) {
    groups.push(
      <section key="fav" aria-label="Favorites">
        <div className="grp">Favorites</div>
        {favorites.map((r) => (
          <VoiceRow key={`fav-${voiceKey(r)}`} row={r} selected={voiceKey(r) === currentKey} favorite previewing={previewKey === voiceKey(r)} playing={playing} showEngine onChoose={onChoose} onFavorite={onFavorite} onPreview={onPreview} />
        ))}
      </section>,
    );
  }
  for (const id of ENGINE_ORDER) {
    const state = engines[id]?.state || 'checking';
    const list = visible.filter((r) => r.engine === id);
    const ready = engineUsable(state);
    if (filtering && ready && list.length === 0) continue;
    const count = rows.filter((r) => r.engine === id && r.id !== '').length;
    groups.push(
      <section key={id} aria-label={engineLabel(id)}>
        <div className="grp">
          <span>{engineLabel(id)}</span>
          <span className="count">{ready && count ? `${count} voice${count === 1 ? '' : 's'}` : ''}</span>
          <EngineStatus state={state} short />
        </div>
        {ready && list.map(row)}
        {state === 'checking' && <div className="grp-note"><span>Checking {engineLabel(id)}…</span><Icon name="loader" size="s" spin /></div>}
        {(state === 'stopped' || state === 'missing') && (
          <div className="grp-note">
            <span>{state === 'missing' ? `${engineLabel(id)} is not installed yet.` : `${engineLabel(id)} is installed but not running.`}</span>
            <button type="button" className="vd-btn quiet sm" onClick={() => onSetup(id)}>{state === 'missing' ? 'Set up' : 'How to start'}</button>
          </div>
        )}
      </section>,
    );
  }

  return (
    <div className="picker" role="dialog" aria-modal="true" aria-label="Choose a voice">
      <div className="pk-head">
        <button type="button" className="vd-icon-btn" aria-label="Back" onClick={onClose}><Icon name="chevron-left" /></button>
        <b>Choose a voice</b>
      </div>
      <div className="pk-tools">
        <label className="search">
          <Icon name="search" size="s" />
          <input ref={searchRef} type="search" placeholder={`Search ${total} voice${total === 1 ? '' : 's'}`} aria-label="Search voices" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="">All languages</option>
          {languagesIn(rows).map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      <div className="pk-list" role="listbox" aria-label="Voices">
        {groups.length ? groups : <div className="grp-note">No voices match.</div>}
      </div>
    </div>
  );
}

function VoiceRow({ row, selected, favorite, previewing, playing, showEngine, onChoose, onFavorite, onPreview }) {
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
      {canFavorite
        ? (
          <button type="button" className={`star${favorite ? ' on' : ''}`} aria-label={favorite ? `Remove ${row.name} from favorites` : `Add ${row.name} to favorites`} aria-pressed={favorite} onClick={(e) => { e.stopPropagation(); onFavorite(row); }}>
            <Icon name="star" size="s" />
          </button>
        )
        : <span className="star-gap" aria-hidden="true" />}
      <span className="vtext">
        <span className="nm">{row.name}{selected && <Icon name="check" size="s" className="sel" />}</span>
        <span className="mt">{row.meta}{showEngine ? ` · ${engineLabel(row.engine)}` : ''}</span>
      </span>
      {row.tag ? <span className="vd-tag">{row.tag}</span> : <span />}
      <button
        type="button"
        className={`pv${previewing ? ' on' : ''}${previewing && playing ? ' live' : ''}`}
        aria-label={previewing ? `Stop the ${row.name} sample` : `Play a sample of ${row.name}`}
        title={previewing ? 'Stop' : 'Play a sample'}
        onClick={(e) => { e.stopPropagation(); onPreview(row); }}
      >
        <Icon name={previewing ? 'stop' : 'play'} size="s" />
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<PopupApp />);
