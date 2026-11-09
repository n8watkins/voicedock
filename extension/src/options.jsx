import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  APP_NAME,
  defaultProfile,
  describeProfileVoice,
  ENGINES,
  engineLabel,
  engineUsable,
  ENGINE_IDS,
  favoritesFor,
  fmt,
  formatBytes,
  formatVoiceName,
  kokoroVoiceDetails,
  pocketVoiceDetails,
  describeEngineEvent,
  fetchEngineEvents,
  piperVoiceDetails,
  LOCAL_ENGINE_IDS,
  MAX_FAVORITES,
  MAX_PROFILES,
  normalizeProfile,
  STATUS_LABEL,
  HUB_URL,
  engineState,
  qualityFromFilename,
  startSeconds,
  runSettingsMigration,
  uuid,
  voicesUrl,
} from './shared.js';
import { EngineMono, EngineStatus, Icon, useEngines } from './ui.jsx';
import { EnginePills, VoiceList } from './picker.jsx';
import { detectOs, NOT_RUNNING_HELP, OS_IDS, OS_LABEL, SETUP_FACTS, setupSteps, startSteps } from './setup.js';
import { buildVoiceCatalog, ENGINE_ORDER, rowForProfile, voiceKey } from './voices.js';

const TABS = ['welcome', 'profiles', 'engines', 'shortcuts', 'about', 'credits'];
const TAB_META = {
  welcome: { label: 'Get started', icon: 'compass' },
  profiles: { label: 'Profiles', icon: 'users' },
  engines: { label: 'Voices & Engines', icon: 'wave' },
  shortcuts: { label: 'Shortcuts', icon: 'keyboard' },
  about: { label: 'How it works', icon: 'info' },
  credits: { label: 'Credits', icon: 'heart' },
};
// Older links: the Voices and Settings tabs are now Voices & Engines.
const TAB_ALIASES = { voices: 'engines', settings: 'engines' };
const SAMPLE_TEXT = 'VoiceDock reads the text you select on any web page. Pick a few sentences, right-click, and choose Read selection.';
const CHROME_COMMANDS = [
  ['read-selection', 'Read or stop'],
  ['pause-resume', 'Pause or resume'],
];

// "#engines:kokoro" opens Voices & Engines with Kokoro's guided setup.
function routeFromHash() {
  const [raw = '', engine = ''] = window.location.hash.replace(/^#\/?/, '').toLowerCase().split(':');
  const route = TAB_ALIASES[raw] || raw;
  return {
    tab: TABS.includes(route) ? route : 'profiles',
    engine: LOCAL_ENGINE_IDS.includes(engine) ? engine : '',
  };
}

function percent(volume) {
  return `${Math.round(Number.parseFloat(volume) * 100)}%`;
}

function emptyEngineMap(value) {
  return Object.fromEntries(LOCAL_ENGINE_IDS.map((id) => [id, typeof value === 'function' ? value() : value]));
}

function Modal({ modal, onConfirm, onCancel }) {
  if (!modal) return null;
  const alertMode = modal.kind === 'alert';
  return (
    <div className="modal-overlay">
      <div className="modal-box" role="dialog" aria-modal="true">
        <p className="modal-msg">{modal.message}</p>
        <div className="modal-actions">
          <button className={`btn ${alertMode ? 'btn-primary' : 'btn-danger'}`} onClick={onConfirm}>{alertMode ? 'Got it' : 'Delete'}</button>
          {!alertMode && <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}

function OptionsApp() {
  const [tab, setTab] = useState(() => routeFromHash().tab);
  // The guided setup panel's engine, or '' when it is closed.
  const [drawer, setDrawer] = useState(() => routeFromHash().engine);
  const [browserVoices, setBrowserVoices] = useState([]);
  const [version, setVersion] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [favoritesByEngine, setFavoritesByEngine] = useState(() => emptyEngineMap(() => []));
  const [deletedVoices, setDeletedVoices] = useState([]);
  const [favsOnly, setFavsOnly] = useState(false);
  const [fallback, setFallback] = useState(true);
  const [voicesByEngine, setVoicesByEngine] = useState(() => emptyEngineMap(() => []));
  const [defaultVoiceByEngine, setDefaultVoiceByEngine] = useState(() => emptyEngineMap(''));
  const [voiceSizes, setVoiceSizes] = useState({});
  const [voiceDir, setVoiceDir] = useState('');
  const [voiceLoadError, setVoiceLoadError] = useState(() => emptyEngineMap(''));
  // Live while it matters: every 5 s on Voices & Engines, every 2 s while the
  // setup panel waits for an engine.
  const { engines, hub, recheck, checkedAt } = useEngines({ pollMs: drawer ? 2000 : tab === 'engines' ? 5000 : 0 });
  // true when the engine answers, false when it doesn't, null while checking.
  const engineStatus = Object.fromEntries(LOCAL_ENGINE_IDS.map((id) => {
    const { state } = engines[id];
    return [id, state === 'checking' ? null : engineUsable(state)];
  }));
  const [voicesEngine, setVoicesEngine] = useState('piper');
  const [createOpen, setCreateOpen] = useState(false);
  const blankProfile = { name: '', engine: 'piper', voice: '', rate: 1.0, volume: 1.0 };
  const [createProfile, setCreateProfile] = useState(blankProfile);
  const [editingId, setEditingId] = useState('');
  const [editDrafts, setEditDrafts] = useState({});
  const [modal, setModal] = useState(null);
  const [chromeCommands, setChromeCommands] = useState([]);
  const [testingVoice, setTestingVoice] = useState('');
  const [welcomeNote, setWelcomeNote] = useState('');
  const createNameRef = useRef(null);

  const activeProfile = profiles.find((profile) => profile.id === activeId) || profiles[0] || null;

  function persist(next) {
    const data = {
      profiles,
      activeId,
      favoritesByEngine,
      deletedVoices,
      favsOnly,
      fallback,
      ...next,
    };
    chrome.storage.local.set({
      profiles: data.profiles,
      activeId: data.activeId,
      favoritesByEngine: data.favoritesByEngine,
      deletedVoices: data.deletedVoices,
      favsOnly: data.favsOnly,
      fallback: data.fallback,
    });
  }

  function showAlert(message) {
    return new Promise((resolve) => {
      setModal({ kind: 'alert', message, resolve });
    });
  }

  function showConfirm(message) {
    return new Promise((resolve) => {
      setModal({ kind: 'confirm', message, resolve });
    });
  }

  function resolveModal(value) {
    modal?.resolve(value);
    setModal(null);
  }

  async function refreshChromeCommands() {
    const commands = await chrome.commands.getAll();
    setChromeCommands(commands);
  }

  function shortcutForCommand(name) {
    return chromeCommands.find((command) => command.name === name)?.shortcut || '';
  }

  function openChromeShortcuts() {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }

  function navigateTab(nextTab) {
    if (!TABS.includes(nextTab)) return;
    window.location.hash = nextTab;
  }

  async function checkEngineStatus(engine) {
    const hub = await recheck();
    return { hub, online: engineUsable(engineState(engine, hub, true)) };
  }

  // Loads one engine's voice list. An offline engine keeps its last list (so
  // saved profile voices still show) and reports no error: the offline banner
  // already says what's wrong.
  async function fetchVoices(engine) {
    const { hub, online } = await checkEngineStatus(engine);
    // The hub lists Kokoro's voices without starting it.
    const url = hub.reachable ? voicesUrl(engine) : null;
    if (!url) {
      setVoiceLoadError((prev) => ({ ...prev, [engine]: '' }));
      return;
    }
    try {
      const res = await fetch(url);
      if (!online && !res.ok) {
        setVoiceLoadError((prev) => ({ ...prev, [engine]: '' }));
        return;
      }
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      setVoicesByEngine((prev) => ({ ...prev, [engine]: Array.isArray(data.voices) ? data.voices : [] }));
      setDefaultVoiceByEngine((prev) => ({ ...prev, [engine]: data.defaultVoice || '' }));
      if (engine === 'piper') {
        setVoiceSizes(data.sizes || {});
        setVoiceDir(data.voiceDir || '');
      }
      setVoiceLoadError((prev) => ({ ...prev, [engine]: '' }));
    } catch (error) {
      if (!online) return; // standby list unavailable: keep the last list quietly
      setVoicesByEngine((prev) => ({ ...prev, [engine]: [] }));
      if (engine === 'piper') {
        setVoiceSizes({});
        setVoiceDir('');
      }
      setVoiceLoadError((prev) => ({ ...prev, [engine]: `Failed to load ${engineLabel(engine)} voices: ${error.message}` }));
    }
  }

  function fetchAllVoices() {
    return Promise.all(LOCAL_ENGINE_IDS.map((engine) => fetchVoices(engine)));
  }

  useEffect(() => {
    async function init() {
      setVersion(`v${chrome.runtime.getManifest().version}`);

      // Upgrades settings saved by 1.0.x (see migrateSettings).
      const stored = await runSettingsMigration(chrome.storage.local);

      let nextProfiles = Array.isArray(stored.profiles) ? stored.profiles.map(normalizeProfile) : [];
      let nextActiveId = stored.activeId || '';
      if (nextProfiles.length === 0) {
        const profile = defaultProfile();
        nextProfiles = [profile];
        nextActiveId = profile.id;
        await chrome.storage.local.set({ profiles: nextProfiles, activeId: nextActiveId });
      }

      const resolvedActiveId = nextProfiles.some((profile) => profile.id === nextActiveId) ? nextActiveId : nextProfiles[0].id;
      setProfiles(nextProfiles);
      setActiveId(resolvedActiveId);
      setFavoritesByEngine({
        piper: favoritesFor(stored.favoritesByEngine, 'piper'),
        kokoro: favoritesFor(stored.favoritesByEngine, 'kokoro'),
        pocket: favoritesFor(stored.favoritesByEngine, 'pocket'),
      });
      setDeletedVoices(Array.isArray(stored.deletedVoices) ? stored.deletedVoices : []);
      setFavsOnly(stored.favsOnly === true);
      setFallback(stored.fallback !== false);
      const activeEngine = nextProfiles.find((profile) => profile.id === resolvedActiveId)?.engine;
      if (LOCAL_ENGINE_IDS.includes(activeEngine)) setVoicesEngine(activeEngine);
      chrome.tts?.getVoices?.().then((voices) => setBrowserVoices(voices || [])).catch(() => {});
      await fetchAllVoices();
      await refreshChromeCommands();
    }
    init();
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const route = routeFromHash();
      setTab(route.tab);
      if (route.engine) setDrawer(route.engine);
    };
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (!document.hidden) refreshChromeCommands();
    };
    window.addEventListener('focus', refreshChromeCommands);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.removeEventListener('focus', refreshChromeCommands);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, []);

  useEffect(() => {
    if (tab === 'engines') fetchVoices(voicesEngine);
  }, [tab, voicesEngine]);

  useEffect(() => {
    if (createOpen) createNameRef.current?.focus();
  }, [createOpen]);

  function setActive(profileId) {
    setActiveId(profileId);
    persist({ activeId: profileId });
  }

  function updateProfiles(nextProfiles, nextActiveId = activeId) {
    setProfiles(nextProfiles);
    setActiveId(nextActiveId);
    persist({ profiles: nextProfiles, activeId: nextActiveId });
  }

  async function createNewProfile() {
    const name = createProfile.name.trim();
    if (!name) {
      createNameRef.current?.focus();
      return;
    }
    if (profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
      await showAlert('A profile with this name already exists.');
      return;
    }
    const profile = normalizeProfile({
      id: uuid(),
      name,
      engine: createProfile.engine,
      voice: createProfile.voice,
      rate: createProfile.rate,
      volume: createProfile.volume,
    });
    updateProfiles([...profiles, profile], profiles.length === 0 ? profile.id : activeId);
    setCreateProfile(blankProfile);
    setCreateOpen(false);
  }

  async function deleteProfile(profileId) {
    if (profiles.length <= 1) return;
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    const confirmed = await showConfirm(`Delete profile "${profile.name}"?`);
    if (!confirmed) return;
    const nextProfiles = profiles.filter((item) => item.id !== profileId);
    updateProfiles(nextProfiles, activeId === profileId ? nextProfiles[0].id : activeId);
  }

  function beginEdit(profile) {
    setEditingId(profile.id);
    setEditDrafts({
      ...editDrafts,
      [profile.id]: {
        name: profile.name,
        engine: profile.engine,
        voice: profile.voice,
        rate: profile.rate ?? 1.0,
        volume: profile.volume ?? 1.0,
      },
    });
  }

  async function saveEdit(profileId) {
    const draft = editDrafts[profileId];
    const name = draft.name.trim();
    if (!name) return;
    if (profiles.some((profile) => profile.id !== profileId && profile.name.toLowerCase() === name.toLowerCase())) {
      await showAlert('A profile with this name already exists.');
      return;
    }
    updateProfiles(profiles.map((profile) =>
      profile.id === profileId
        ? normalizeProfile({ ...profile, name, engine: draft.engine, voice: draft.voice, rate: draft.rate, volume: draft.volume })
        : profile,
    ));
    setEditingId('');
  }

  function updateDraft(profileId, patch) {
    setEditDrafts({
      ...editDrafts,
      [profileId]: { ...editDrafts[profileId], ...patch },
    });
  }

  async function toggleFavorite(engine, voice) {
    const current = favoritesFor(favoritesByEngine, engine);
    let nextList;
    if (current.includes(voice)) {
      nextList = current.filter((favorite) => favorite !== voice);
    } else {
      if (current.length >= MAX_FAVORITES) {
        await showAlert(`${MAX_FAVORITES} ${engineLabel(engine)} favorites max. Unstar one first.`);
        return;
      }
      nextList = [...current, voice];
    }
    const next = { ...favoritesByEngine, [engine]: nextList };
    setFavoritesByEngine(next);
    persist({ favoritesByEngine: next });
  }

  function testKey(settings) {
    return `${settings.engine}:${settings.voice || ''}`;
  }

  function testVoice(settings = {}) {
    const testSettings = normalizeProfile({ ...settings, name: 'Test' });
    setTestingVoice(testKey(testSettings));
    const voiceName = testSettings.engine === 'browser'
      ? 'the Basic voice'
      : `the voice ${formatVoiceName(testSettings.voice, `${engineLabel(testSettings.engine)} default voice`)}`;
    chrome.runtime.sendMessage({
      type: 'test-voice',
      text: `This is a test of ${voiceName}.`,
      settings: testSettings,
    }, (response) => {
      setTestingVoice('');
      const runtimeErr = chrome.runtime.lastError;
      if (runtimeErr) {
        showAlert(`Extension error: ${runtimeErr.message}`);
        return;
      }
      if (response && !response.ok) {
        showAlert(`Test failed: ${response.error || 'Unknown error'}`);
      } else if (response?.fellBack) {
        showAlert(`${engineLabel(testSettings.engine)} isn't running, so the Basic voice played.`);
      }
    });
  }

  // Get started: read the sample with the active profile and say which voice
  // actually played.
  function readSample() {
    const settings = normalizeProfile(activeProfile || defaultProfile());
    setTestingVoice('welcome');
    setWelcomeNote('');
    chrome.runtime.sendMessage({ type: 'test-voice', text: SAMPLE_TEXT, settings }, (response) => {
      setTestingVoice('');
      if (chrome.runtime.lastError || !response) {
        setWelcomeNote('Something went wrong. Reload the page and try again.');
      } else if (!response.ok) {
        setWelcomeNote(`${response.error}. Turn on the Basic voice fallback in Voices & Engines to hear it.`);
      } else if (response.fellBack) {
        setWelcomeNote(`${engineLabel(settings.engine)} isn't running, so the Basic voice read it.`);
      } else {
        setWelcomeNote(`Reading with ${describeProfileVoice(settings)}.`);
      }
    });
  }

  // Points the active profile at a local engine that is now running, with that
  // engine's default voice.
  function useEngine(engine) {
    if (!activeProfile) return;
    const nextProfiles = profiles.map((profile) => profile.id === activeProfile.id
      ? { ...profile, engine, voice: defaultVoiceByEngine[engine] || '' }
      : profile);
    updateProfiles(nextProfiles, activeProfile.id);
    setWelcomeNote(`${activeProfile.name} now reads with ${engineLabel(engine)}.`);
  }

  async function deleteVoice(filename) {
    const confirmed = await showConfirm(`Delete "${formatVoiceName(filename)}" from disk? This can't be undone.`);
    if (!confirmed) return;
    try {
      const res = await fetch(`${HUB_URL}/voices/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server responded ${res.status}`);
      }
      const nextDeleted = [
        { filename, displayName: formatVoiceName(filename), deletedAt: new Date().toLocaleDateString() },
        ...deletedVoices.filter((item) => item.filename !== filename),
      ];
      const nextFavorites = {
        ...favoritesByEngine,
        piper: favoritesFor(favoritesByEngine, 'piper').filter((favorite) => favorite !== filename),
      };
      const nextProfiles = profiles.map((profile) =>
        profile.engine === 'piper' && profile.voice === filename ? { ...profile, voice: '' } : profile,
      );
      setDeletedVoices(nextDeleted);
      setFavoritesByEngine(nextFavorites);
      setProfiles(nextProfiles);
      setVoicesByEngine((prev) => ({ ...prev, piper: prev.piper.filter((voice) => voice !== filename) }));
      persist({ deletedVoices: nextDeleted, favoritesByEngine: nextFavorites, profiles: nextProfiles });
    } catch (error) {
      await showAlert(`Delete failed: ${error.message}`);
    }
  }

  function openVoicesFolder() {
    fetch(`${HUB_URL}/voices/open-folder`, { method: 'POST' }).catch(() => {});
  }

  const viewFavorites = favoritesFor(favoritesByEngine, voicesEngine);
  const visibleVoices = useMemo(() => {
    const all = voicesByEngine[voicesEngine] || [];
    const pool = favsOnly ? all.filter((voice) => viewFavorites.includes(voice)) : all;
    return [
      ...pool.filter((voice) => viewFavorites.includes(voice)).sort(),
      ...pool.filter((voice) => !viewFavorites.includes(voice)).sort(),
    ];
  }, [voicesByEngine, voicesEngine, viewFavorites, favsOnly]);
  const viewOnline = engineStatus[voicesEngine];

  // Every voice the profile forms can pick, per engine. Each local engine also
  // get a "Default" row (their server's default voice).
  const catalog = useMemo(() => {
    const rows = buildVoiceCatalog({
      piper: voicesByEngine.piper || [],
      kokoro: voicesByEngine.kokoro || [],
      pocket: voicesByEngine.pocket || [],
      browser: browserVoices,
    });
    const defaults = LOCAL_ENGINE_IDS.map((engine) => ({
      engine, id: '', name: 'Default voice', meta: defaultVoiceByEngine[engine] ? (engine === 'pocket' ? pocketVoiceDetails(defaultVoiceByEngine[engine])?.name : formatVoiceName(defaultVoiceByEngine[engine])) : 'The server\'s default', language: '', tag: '',
    }));
    return [...defaults, ...rows];
  }, [voicesByEngine, browserVoices, defaultVoiceByEngine]);

  // Engine pills, then a dropdown of that engine's voices (src/picker.jsx).
  function voicePicker(draft, onChange) {
    return (
      <VoiceField
        draft={draft}
        rows={catalog}
        engines={engines}
        favoritesByEngine={favoritesByEngine}
        previewKey={testingVoice}
        onChange={onChange}
        onFavorite={(row) => toggleFavorite(row.engine, row.id)}
        onPreview={(row) => testVoice({ engine: row.engine, voice: row.id })}
        onSetup={(engine) => openSetup(engine)}
      />
    );
  }

  function openSetup(engine) {
    if (LOCAL_ENGINE_IDS.includes(engine)) setDrawer(engine);
  }

  function closeSetup() {
    setDrawer('');
    // Drop the engine from the address, so a reload doesn't reopen it.
    if (routeFromHash().engine) history.replaceState(null, '', `#${tab}`);
  }

  function profileForm(draft, patch) {
    return (
      <div className="form-stack">
        <label className="field">
          <span className="form-label">Name</span>
          <input className="form-input" type="text" maxLength={40} placeholder="e.g. Audiobooks" value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
        </label>
        <div className="field">
          <span className="form-label">Voice</span>
          {voicePicker(draft, (engine, voice) => patch({ engine, voice }))}
        </div>
        {/* Two columns: speed and volume are short, related sliders. */}
        <div className="form-two">
          <label className="field">
            <span className="form-label">Speed <b>{fmt(draft.rate)}×</b></span>
            <input className="slider" type="range" min="0.5" max="2.5" step="0.1" value={draft.rate} onChange={(event) => patch({ rate: event.target.value })} />
          </label>
          <label className="field">
            <span className="form-label">Volume <b>{percent(draft.volume)}</b></span>
            <input className="slider" type="range" min="0" max="2" step="0.05" value={draft.volume} onChange={(event) => patch({ volume: event.target.value })} />
          </label>
        </div>
      </div>
    );
  }

  const readShortcut = shortcutForCommand('read-selection');

  return (
    <div className="page">
      <aside className="side">
        <div className="brand">
          <img className="page-icon" src="icons/icon48.png" alt="" />
          <div>
            <h1 className="page-title">{APP_NAME}</h1>
            <span className="page-version">{version}</span>
          </div>
        </div>
        <nav className="side-nav" role="tablist" aria-label="Sections" aria-orientation="vertical">
          {TABS.map((name) => (
            <button key={name} className={`tab ${tab === name ? 'active' : ''}`} role="tab" aria-selected={tab === name} onClick={() => navigateTab(name)}>
              <Icon name={TAB_META[name].icon} />
              <span>{TAB_META[name].label}</span>
            </button>
          ))}
        </nav>
        <div className="side-engines" aria-label="Engines">
          {LOCAL_ENGINE_IDS.map((engine) => (
            <span key={engine} className="header-engine" title={engines[engine].detail || undefined}>
              <span>{engineLabel(engine)}</span> <EngineStatus state={engines[engine].state} variant="compact" short />
            </span>
          ))}
        </div>
      </aside>

      <main className="main">
      {tab === 'welcome' && (() => {
        const activeEngine = activeProfile?.engine || 'browser';
        const anyLocal = LOCAL_ENGINE_IDS.some((engine) => engineStatus[engine]);
        return (
        <section className="tab-panel welcome" role="tabpanel">
          <div className="panel-toolbar"><h2 className="panel-heading">Welcome to VoiceDock</h2></div>
          <p className="panel-blurb">Reads selected text aloud. The <strong>Basic voice</strong> works now; <strong>Piper</strong>, <strong>Kokoro</strong> and <strong>Pocket TTS</strong> add natural voices that run on this computer.</p>

          <div className="settings-group">
            <h3 className="settings-group-title"><Icon name="play" size="s" />1. Try it</h3>
            <p className="welcome-sample">{SAMPLE_TEXT}</p>
            <div className="welcome-actions">
              <button className="btn btn-primary" disabled={testingVoice === 'welcome'} onClick={readSample}><Icon name="play" size="s" />{testingVoice === 'welcome' ? 'Starting…' : 'Read this aloud'}</button>
              <span className="setting-desc">With {activeProfile ? describeProfileVoice(activeProfile) : 'the Basic voice'}</span>
            </div>
            {welcomeNote && <p className="welcome-note" role="status">{welcomeNote}</p>}
            <p className="setting-desc welcome-how">On any page: select text, right-click, <em>Read selection</em>{readShortcut ? <>, or <kbd>{readShortcut}</kbd></> : ''}.</p>
          </div>

          <div className="settings-group">
            <div className="welcome-group-head">
              <h3 className="settings-group-title"><Icon name="cpu" size="s" />2. Voices on this computer</h3>
              <button className="btn btn-ghost btn-sm" onClick={fetchAllVoices}><Icon name="refresh" size="s" />Check again</button>
            </div>
            <ul className="welcome-engines">
              {ENGINE_ORDER.map((engine) => {
                const usable = engine === 'browser' || engineStatus[engine];
                return (
                  <li key={engine}>
                    <EngineMono engine={engine} small />
                    <span className="welcome-engine-name">{engineLabel(engine)}</span>
                    <EngineStatus state={engines[engine].state} short />
                    <span className="setting-desc">{ENGINES[engine].short}</span>
                    {usable && engine !== 'browser' && activeEngine !== engine && activeProfile
                      ? <button className="btn btn-primary btn-sm welcome-use" onClick={() => useEngine(engine)}>Use {engineLabel(engine)}</button>
                      : <span />}
                  </li>
                );
              })}
            </ul>
          </div>

          {LOCAL_ENGINE_IDS.some((engine) => !engineStatus[engine]) && (
            <div className="settings-group">
              <h3 className="settings-group-title"><Icon name="terminal" size="s" />3. Add natural voices</h3>
              <p className="setting-desc">Free, and they run on this computer. Start with Piper: Kokoro and Pocket TTS run through Piper's server.</p>
              <div className="welcome-setup">
                {LOCAL_ENGINE_IDS.filter((engine) => !engineStatus[engine]).map((engine) => (
                  <button key={engine} className={`btn btn-sm ${engine === 'piper' || engineStatus.piper ? 'btn-primary' : 'btn-ghost'}`} onClick={() => openSetup(engine)}>
                    <Icon name="terminal" size="s" />{engines[engine].state === 'stopped' ? `Start ${engineLabel(engine)}` : `Set up ${engineLabel(engine)}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {anyLocal && activeEngine !== 'browser' && (
            <p className="setting-desc welcome-done"><Icon name="check" size="s" />Set: {activeProfile?.name} reads with {engineLabel(activeEngine)}.</p>
          )}
        </section>
        );
      })()}

      {tab === 'profiles' && (
        <section className="tab-panel" role="tabpanel">
          <div className="panel-toolbar">
            <h2 className="panel-heading">Profiles</h2>
            <span className="panel-hint">{profiles.length} / {MAX_PROFILES}</span>
            <button className="btn btn-primary" disabled={profiles.length >= MAX_PROFILES} onClick={() => {
              setCreateProfile({ ...blankProfile, engine: activeProfile?.engine || 'piper' });
              setCreateOpen(true);
            }}><Icon name="plus" size="s" />New profile</button>
          </div>
          <p className="panel-blurb">A voice, speed and volume under one name. Switch in the popup.</p>

          {createOpen && (
            <div className="create-form">
              <h3 className="form-title">New profile</h3>
              {profileForm(createProfile, (patch) => setCreateProfile({ ...createProfile, ...patch }))}
              <div className="form-actions">
                <button className="btn btn-primary" onClick={createNewProfile}>Save profile</button>
                <button className="btn btn-ghost" onClick={() => {
                  setCreateOpen(false);
                  setCreateProfile(blankProfile);
                }}>Cancel</button>
              </div>
            </div>
          )}

          <div className="profile-list">
            {profiles.map((profile) => {
              const isActive = profile.id === activeProfile?.id;
              const draft = editDrafts[profile.id] || profile;
              const editing = editingId === profile.id;
              return (
                <div key={profile.id} className={`profile-card ${isActive ? 'is-active' : ''}`} data-id={profile.id}>
                  <div className="profile-card-header">
                    <EngineMono engine={profile.engine} small />
                    <div className="profile-card-info">
                      <span className="profile-card-name">{profile.name}{isActive && <span className="vd-tag active-tag">Active</span>}</span>
                      <span className="profile-card-meta">{describeProfileVoice(profile)}  ·  {fmt(profile.rate)}×  ·  {percent(profile.volume)}</span>
                    </div>
                    <div className="profile-card-btns">
                      {!isActive && <button className="btn btn-ghost btn-sm" onClick={() => setActive(profile.id)}>Make active</button>}
                      <button className="btn-icon btn-icon-edit" title="Edit profile" aria-label="Edit profile" onClick={() => editing ? setEditingId('') : beginEdit(profile)}><Icon name="pencil" size="s" /></button>
                      <button className="btn-icon btn-icon-delete" disabled={profiles.length <= 1} title={profiles.length <= 1 ? "Can't delete the only profile" : 'Delete profile'} aria-label="Delete profile" onClick={() => deleteProfile(profile.id)}><Icon name="trash" size="s" /></button>
                    </div>
                  </div>

                  {editing && (
                    <div className="profile-edit-form">
                      {profileForm(draft, (patch) => updateDraft(profile.id, patch))}
                      <div className="profile-edit-actions">
                        <button className="btn btn-primary btn-sm" onClick={() => saveEdit(profile.id)}>Save</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingId('')}>Cancel</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => testVoice(draft)}><Icon name="play" size="s" />{testingVoice === testKey(normalizeProfile(draft)) ? 'Playing…' : 'Test'}</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {tab === 'engines' && (
        <section className="tab-panel" role="tabpanel">
          <div className="panel-toolbar">
            <h2 className="panel-heading">Voices &amp; Engines</h2>
            <span className="panel-hint engines-checked" aria-live="polite">{checkedAt ? (hub?.reachable === false ? "VoiceDock's server is not running" : 'Checked just now') : 'Checking'}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => recheck()}><Icon name="refresh" size="s" />Check again</button>
          </div>
          <p className="panel-blurb">Each engine is a set of voices that runs on this computer. Text never leaves it.</p>

          <h3 className="section-title"><Icon name="cpu" size="s" />On this computer</h3>
          <div className="engine-cards">
            {LOCAL_ENGINE_IDS.map((engine) => (
              <EngineCard
                key={engine}
                engine={engine}
                state={engines[engine].state}
                entry={engines[engine].entry}
                detail={engines[engine].detail}
                hub={hub}
                sampling={testingVoice === testKey(normalizeProfile({ engine, voice: '' }))}
                onSample={() => testVoice({ engine, voice: '' })}
                onSetup={() => openSetup(engine)}
                onVoices={() => { setVoicesEngine(engine); document.getElementById('voices')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}
              />
            ))}
          </div>

          <div className="settings-group fallback-group">
            <div className="basic-row" data-engine="browser">
              <EngineMono engine="browser" small />
              <div className="basic-row-text">
                <span className="basic-row-title"><b>{engineLabel('browser')}</b><EngineStatus state="ready" /></span>
                <span className="setting-desc">Chrome's built-in speech: no setup, nothing to download.</span>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => testVoice({ engine: 'browser', voice: '' })} disabled={testingVoice === testKey(normalizeProfile({ engine: 'browser', voice: '' }))}>
                <Icon name="play" size="s" />Play a sample
              </button>
            </div>
            <label className="setting-row switch-row">
              <input type="checkbox" role="switch" className="switch" checked={fallback} onChange={(event) => {
                setFallback(event.target.checked);
                persist({ fallback: event.target.checked });
              }} />
              <div>
                <span className="setting-label">Fall back to the Basic voice</span>
                <span className="setting-desc">When a profile's engine can't read, the Basic voice reads instead. Off: VoiceDock stays silent and says why.</span>
              </div>
            </label>
          </div>

          <div className="panel-toolbar voices-toolbar" id="voices">
            <h3 className="section-title"><Icon name="mic" size="s" />Voices</h3>
            <span className="favs-count"><Icon name="star" size="s" />{viewFavorites.length} / {MAX_FAVORITES}</span>
            <label className="toggle-label">
              <input type="checkbox" checked={favsOnly} onChange={(event) => {
                setFavsOnly(event.target.checked);
                persist({ favsOnly: event.target.checked });
              }} />
              <span>Favorites only</span>
            </label>
          </div>
          <div className="voices-engines">
            <EnginePills engines={engines} ids={LOCAL_ENGINE_IDS} value={voicesEngine} onChange={setVoicesEngine} />
          </div>

          {viewOnline === false && engines[voicesEngine].state !== 'standby' && (
            <EngineSetupInline engine={voicesEngine} state={engines[voicesEngine].state} onSetup={openSetup} />
          )}
          {voicesEngine === 'piper' && voiceDir && (
            <div className="voices-folder-bar">
              <Icon name="folder" size="s" />
              <code className="voices-folder-path">{voiceDir}</code>
              <button className="btn btn-ghost btn-sm" onClick={openVoicesFolder}>Open folder</button>
            </div>
          )}

          {/* Two columns: voices are short, uniform rows, and Kokoro has 54. */}
          <div className="voice-grid">
            {visibleVoices.length === 0 && (viewOnline || favsOnly) && (
              <p className="no-items">{voiceLoadError[voicesEngine] || (favsOnly
                ? 'No favorites yet. Star a voice to add it.'
                : (voicesEngine === 'piper' ? 'No voices yet. Add .onnx files to the voices folder.' : `${engineLabel(voicesEngine)} listed no voices.`))}</p>
            )}
            {visibleVoices.map((voice) => {
              const isFav = viewFavorites.includes(voice);
              const quality = voicesEngine === 'piper' ? qualityFromFilename(voice) : null;
              const kokoro = voicesEngine === 'kokoro' ? kokoroVoiceDetails(voice) : null;
              const pocket = voicesEngine === 'pocket' ? pocketVoiceDetails(voice) : null;
              const details = kokoro || pocket || piperVoiceDetails(voice);
              const isDefault = voice === defaultVoiceByEngine[voicesEngine];
              const settings = { engine: voicesEngine, voice };
              return (
                <div key={voice} className="voice-card" data-voice={voice}>
                  <button className={`voice-fav-btn ${isFav ? 'is-fav' : ''}`} title={isFav ? 'Remove from favorites' : 'Add to favorites'} aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={isFav} onClick={() => toggleFavorite(voicesEngine, voice)}><Icon name="star" /></button>
                  <div className="voice-card-info">
                    <span className="voice-card-name">
                      {kokoro || pocket ? details.name : (piperVoiceDetails(voice)?.name || formatVoiceName(voice))}
                      {isDefault && <span className="lang-badge lang-badge-default">Default</span>}
                    </span>
                    <span className="voice-card-file">
                      {[details?.language, kokoro?.gender, pocket?.accent, quality && { x_low: 'Extra low', low: 'Low', med: 'Medium', high: 'High' }[quality], voicesEngine === 'piper' && formatBytes(voiceSizes[voice])].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <div className="voice-card-btns">
                    <button className="vd-icon-btn" title="Play a sample" aria-label={`Play a sample of ${details?.name || voice}`} onClick={() => testVoice(settings)}><Icon name={testingVoice === testKey(settings) ? 'loader' : 'play'} size="s" spin={testingVoice === testKey(settings)} /></button>
                    {voicesEngine === 'piper' && <button className="vd-icon-btn danger" title="Delete from disk" aria-label={`Delete ${details?.name || voice}`} onClick={() => deleteVoice(voice)}><Icon name="trash" size="s" /></button>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="voices-footer">
            {voicesEngine === 'piper' && <a className="link-external" href="https://huggingface.co/rhasspy/piper-voices/tree/main/en" target="_blank">More Piper voices <Icon name="external" size="s" className="inline" /></a>}
            {voicesEngine === 'kokoro' && <a className="link-external" href="https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md" target="_blank">Kokoro voice grades <Icon name="external" size="s" className="inline" /></a>}
            {voicesEngine === 'pocket' && <a className="link-external" href="https://huggingface.co/kyutai/tts-voices" target="_blank">Pocket TTS voices and their licenses <Icon name="external" size="s" className="inline" /></a>}
          </div>

          <EngineHistory hub={hub} />

          {voicesEngine === 'piper' && deletedVoices.length > 0 && (
            <details className="deleted-section">
              <summary className="deleted-summary">
                <Icon name="trash" size="s" />
                <span>Deleted voices</span>
                <span className="deleted-count">({deletedVoices.length})</span>
              </summary>
              <div className="deleted-list">
                {deletedVoices.map((deleted) => (
                  <div key={deleted.filename} className="deleted-item">
                    <span>{deleted.displayName}</span>
                    <span className="deleted-item-date">{deleted.deletedAt}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      {tab === 'shortcuts' && (
        <section className="tab-panel" role="tabpanel">
          <div className="panel-toolbar"><h2 className="panel-heading">Shortcuts</h2></div>
          <div className="settings-group">
            {CHROME_COMMANDS.map(([command, label]) => {
              const shortcut = shortcutForCommand(command);
              return (
                <div className="shortcut-row" key={command}>
                  <span className="shortcut-label">{label}</span>
                  <span className={`shortcut-bind-btn ${shortcut ? '' : 'is-unset'}`}>{shortcut || 'Not set'}</span>
                </div>
              );
            })}
            <div className="shortcut-actions">
              <span className="setting-desc">Change them in Chrome.</span>
              <button className="btn btn-ghost btn-sm" onClick={refreshChromeCommands}><Icon name="refresh" size="s" />Refresh</button>
              <button className="btn btn-ghost btn-sm" onClick={openChromeShortcuts}><Icon name="external" size="s" />Open Chrome shortcuts</button>
            </div>
          </div>
        </section>
      )}

      {tab === 'about' && (
        <section className="tab-panel" role="tabpanel">
          <div className="panel-toolbar"><h2 className="panel-heading">How it works</h2></div>
          <ol className="how-it-works-list">
            <li><span className="flow-step"><Icon name="type" size="s" /></span><div><strong>Select text</strong>, then right-click <em>Read selection</em> or press <kbd>{readShortcut || 'the shortcut'}</kbd>.</div></li>
            <li><span className="flow-step"><Icon name="cpu" size="s" /></span><div>Your profile's engine speaks it on this computer, through VoiceDock's local server at <code>127.0.0.1:7477</code>. It starts <strong>Kokoro</strong> when you read with it and stops it when you don't.</div></li>
            <li><span className="flow-step"><Icon name="wave" size="s" /></span><div>It reads <strong>sentence by sentence</strong>; the player bar on the page pauses, skips and stops.</div></li>
            <li><span className="flow-step"><Icon name="shield" size="s" /></span><div>An engine that can't read falls back to the <strong>Basic voice</strong> (Voices &amp; Engines), and the page says so.</div></li>
            <li><span className="flow-step"><Icon name="globe" size="s" /></span><div><strong>Nothing leaves your machine</strong>: no cloud, no account, no API key.</div></li>
          </ol>
          <a className="link-external about-readme" href="https://github.com/n8watkins/voicedock#readme" target="_blank">README and setup guide <Icon name="external" size="s" className="inline" /></a>
        </section>
      )}

      {tab === 'credits' && (
        <section className="tab-panel" role="tabpanel">
          <div className="panel-toolbar"><h2 className="panel-heading">Credits</h2></div>
          <h3 className="section-title"><Icon name="heart" size="s" />Built on</h3>
          <div className="credits-deps">
            {CREDITS.map((credit) => (
              <a key={credit.name} className="dep-card" href={credit.href} target="_blank">
                <span className="dep-logo">{credit.mono ? <EngineMono engine={credit.mono} small /> : <Icon name={credit.icon} />}</span>
                <span className="dep-text"><span className="dep-name">{credit.name}</span><span className="dep-desc">{credit.desc}</span></span>
              </a>
            ))}
          </div>
          <h3 className="section-title"><Icon name="scale" size="s" />Source and license</h3>
          <a className="dep-card dep-card-github" href="https://github.com/n8watkins/voicedock" target="_blank">
            <span className="dep-logo"><Icon name="github" /></span>
            <span className="dep-text"><span className="dep-name">n8watkins/voicedock</span><span className="dep-desc">MIT. Runs locally, no cloud.</span></span>
          </a>
        </section>
      )}
      </main>

      {drawer && (
        <SetupDrawer
          engine={drawer}
          engines={engines}
          recheck={recheck}
          activeProfile={activeProfile}
          sampling={testingVoice === testKey(normalizeProfile({ engine: drawer, voice: '' }))}
          onSample={() => testVoice({ engine: drawer, voice: '' })}
          onUse={() => { useEngine(drawer); }}
          onClose={closeSetup}
        />
      )}
      <Modal modal={modal} onConfirm={() => resolveModal(true)} onCancel={() => resolveModal(false)} />
    </div>
  );
}

const CREDITS = [
  { name: 'Piper', desc: 'Fast local speech, by rhasspy and OHF-Voice', href: 'https://github.com/OHF-Voice/piper1-gpl', mono: 'piper' },
  { name: 'Piper voices', desc: 'Voice models, on Hugging Face', href: 'https://huggingface.co/rhasspy/piper-voices', icon: 'mic' },
  { name: 'Kokoro-82M', desc: 'Natural open-weight voices, by hexgrad (Apache 2.0)', href: 'https://huggingface.co/hexgrad/Kokoro-82M', mono: 'kokoro' },
  { name: 'kokoro-onnx', desc: 'Runs Kokoro on ONNX Runtime, by thewh1teagle', href: 'https://github.com/thewh1teagle/kokoro-onnx', icon: 'cpu' },
  { name: 'Pocket TTS', desc: 'English voices on the CPU, by Kyutai (MIT, model CC-BY-4.0). No cloning a voice without consent.', href: 'https://github.com/kyutai-labs/pocket-tts', mono: 'pocket' },
  { name: 'uv', desc: 'Installs Kokoro\'s Python, by Astral', href: 'https://github.com/astral-sh/uv', icon: 'package' },
  { name: 'Lucide', desc: 'The icon style (ISC)', href: 'https://lucide.dev', icon: 'shapes' },
  { name: 'Onest, Bricolage Grotesque', desc: 'Typefaces (SIL OFL)', href: 'https://github.com/googlefonts/onest', icon: 'type' },
];

// One engine at a glance: its state in words, four facts, and the one
// button that matters in that state.
function EngineCard({ engine, state, entry, detail, hub, sampling, onSample, onSetup, onVoices }) {
  const { facts, blurb } = ENGINES[engine];
  const local = ENGINES[engine].local;
  // Piper has no process while idle (one per read); Kokoro's is the engine's.
  const memory = engine === 'piper'
    ? (entry?.speaking && entry.rssMb ? `${Math.round(entry.rssMb)} MB reading now` : facts.memory)
    : entry?.rssMb ? `${Math.round(entry.rssMb)} MB now` : engineUsable(state) ? 'None now' : facts.memory;
  const heavy = engine === 'kokoro' || engine === 'pocket';
  const memoryNote = heavy && (entry?.rssMb || engineUsable(state)) ? facts.memory : '';
  const firstAudio = heavy
    ? (entry?.modelLoaded ? `At once, ${engine === 'kokoro' ? 'model loaded' : 'running'}` : `About ${startSeconds(engine, hub)} s from cold`)
    : engine === 'piper' ? 'About 1 s' : 'At once';
  return (
    <div className={`engine-card state-${state}`} data-engine={engine}>
      <div className="engine-card-head">
        <EngineMono engine={engine} />
        <div className="engine-card-title">
          <b>{engineLabel(engine)}</b>
          <EngineStatus state={state} />
        </div>
      </div>
      <p className="engine-card-blurb">{blurb}</p>
      <dl className="engine-facts">
        <dt>Now</dt><dd className="engine-detail">{detail || STATUS_LABEL[state]}</dd>
        <dt>Memory</dt><dd>{memory}{memoryNote ? <span className="fact-sub"> · {memoryNote}</span> : null}</dd>
        <dt>Download</dt><dd>{facts.download}</dd>
        <dt>First audio</dt><dd>{firstAudio}</dd>
      </dl>
      <div className="engine-card-actions">
        {state === 'missing' && <button className="btn btn-sm btn-primary" onClick={onSetup}><Icon name="terminal" size="s" />Set up</button>}
        {state === 'stopped' && <button className="btn btn-sm btn-primary" onClick={onSetup}><Icon name="terminal" size="s" />How to start</button>}
        {state === 'checking' && <button className="btn btn-sm btn-ghost" disabled><Icon name="loader" size="s" spin />Checking</button>}
        {engineUsable(state) && (
          <button className="btn btn-sm btn-ghost" onClick={onSample} disabled={sampling}>
            <Icon name={sampling ? 'loader' : 'play'} size="s" spin={sampling} />{sampling ? 'Playing' : 'Play a sample'}
          </button>
        )}
        {local && engineUsable(state) && <button className="btn btn-sm btn-ghost" onClick={onVoices}><Icon name="mic" size="s" />Voices</button>}
        {local && engineUsable(state) && <button className="btn btn-sm btn-link" onClick={onSetup}>Setup steps</button>}
      </div>
    </div>
  );
}

// The hub's recent engine events (GET /hub/events), newest first: when each
// engine started and how long it took, when and why it stopped, refusals
// and memory pressure. Loaded when opened, and again with Refresh.
function EngineHistory({ hub }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [all, setAll] = useState(false);
  const load = useCallback(() => { fetchEngineEvents().then(setResult); }, []);
  useEffect(() => { if (open) load(); }, [open, load, hub?.reachable]);
  const events = (result?.events || []).slice().reverse();
  const shown = all ? events : events.slice(0, 12);
  return (
    <details className="settings-group engine-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="history-summary">
        <Icon name="clock" size="s" />
        <span>Engine history</span>
        {result?.reachable && <span className="history-count">({events.length})</span>}
        <Icon name="chevron-down" size="s" className="history-chevron" />
      </summary>
      <div className="history-body">
        <div className="history-head">
          <span className="setting-desc">Since VoiceDock's server started: starts, stops and why. Nothing about what was read.</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={load}><Icon name="refresh" size="s" />Refresh</button>
        </div>
        {result === null && <p className="setting-desc">Loading…</p>}
        {result && !result.reachable && <p className="setting-desc">VoiceDock's server is not running, so there is no history to show.</p>}
        {result?.reachable && events.length === 0 && <p className="setting-desc">Nothing yet: engines start when you read.</p>}
        {shown.length > 0 && (
          <ol className="history-list">
            {shown.map((event, i) => {
              const { text, tone } = describeEngineEvent(event);
              const at = new Date(event.at);
              return (
                <li key={`${event.at}-${i}`} className={tone ? `tone-${tone}` : undefined}>
                  <time dateTime={event.at}>{Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                  <span>{text}</span>
                </li>
              );
            })}
          </ol>
        )}
        {events.length > shown.length && <button type="button" className="btn btn-link btn-sm" onClick={() => setAll(true)}>Show all {events.length}</button>}
      </div>
    </details>
  );
}

// A copyable command block: each line runs on its own.
function CommandBlock({ commands }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(commands.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }
  return (
    <div className="cmd">
      <pre>{commands.join('\n')}</pre>
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy} aria-label={copied ? 'Copied' : `Copy: ${commands.join(' then ')}`}>
        <Icon name={copied ? 'check' : 'copy'} size="s" />{copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// Numbered steps for one engine, with a tab per OS (this OS first): how to
// set it up, or, when it is set up but not running, how to start it.
function SetupGuide({ engine, mode = 'setup' }) {
  const [os, setOs] = useState(detectOs);
  const steps = mode === 'start' ? startSteps(engine, os) : setupSteps(engine, os);
  const facts = SETUP_FACTS[engine];
  return (
    <div className="setup-guide" data-mode={mode}>
      <div className="setup-tabs">
        <div className="os-tabs" role="tablist" aria-label="Your computer">
          {OS_IDS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={os === id} className={`os-tab${os === id ? ' active' : ''}`} onClick={() => setOs(id)}>
              <Icon name="monitor" size="s" />{OS_LABEL[id]}
            </button>
          ))}
        </div>
      </div>
      {mode === 'setup' && <p className="setup-facts">Needs {facts.needs} · {facts.size} download</p>}
      <ol className="setup-steps">
        {steps.map((step, i) => (
          <li key={step.title}>
            <span className="step-num">{i + 1}</span>
            <div className="step-body">
              <b>{step.title}</b>
              <span className="setting-desc">{step.what}</span>
              {step.commands && <CommandBlock commands={step.commands} />}
            </div>
          </li>
        ))}
      </ol>
      {mode === 'setup' && <p className="setup-worked"><Icon name="check" size="s" /><span><b>Worked?</b> {facts.worked}</span></p>}
    </div>
  );
}

// The guided setup panel: the steps for one engine, and a live check that
// asks the hub every 2 seconds and turns green when the engine can read.
function SetupDrawer({ engine, engines, recheck, activeProfile, sampling, onSample, onUse, onClose }) {
  const { state, detail } = engines[engine];
  const label = engineLabel(engine);
  const usable = engineUsable(state);
  // The steps follow the engine's first known state, so the list never swaps
  // under the reader when the engine comes up.
  const [fixedMode, setFixedMode] = useState(state === 'checking' ? '' : state === 'stopped' ? 'start' : 'setup');
  useEffect(() => {
    if (!fixedMode && state !== 'checking') setFixedMode(state === 'stopped' ? 'start' : 'setup');
  }, [fixedMode, state]);
  const mode = fixedMode || 'setup';
  const panelRef = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    panelRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); before?.focus?.(); };
  }, []);
  const title = state === 'checking' && !fixedMode ? label : mode === 'start' ? `Start ${label}` : `Set up ${label}`;
  const usesIt = activeProfile?.engine === engine;
  return (
    <div className="drawer-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={panelRef} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" data-engine={engine}>
        <header className="drawer-head">
          <EngineMono engine={engine} />
          <div className="drawer-title">
            <h2 id="drawer-title">{title}</h2>
            <EngineStatus state={state} />
          </div>
          <button type="button" className="vd-icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="drawer-body">
          {mode === 'start' && detail && <p className="drawer-why"><Icon name="info" size="s" />{detail}</p>}
          {mode === 'start' && <p className="setting-desc">{NOT_RUNNING_HELP[engine].means}</p>}
          <SetupGuide engine={engine} mode={mode} />
        </div>
        <footer className={`drawer-live${usable ? ' is-ready' : ''}`} role="status" aria-live="polite">
          {usable ? (
            <>
              <span className="drawer-live-text"><Icon name="check" size="s" /><b>{state === 'standby' ? `${label} is set up.` : `${label} is ready.`}</b> {state === 'standby' ? 'It starts when you read.' : ''}</span>
              <span className="drawer-live-actions">
                <button className="btn btn-sm btn-ghost" onClick={onSample} disabled={sampling}><Icon name={sampling ? 'loader' : 'play'} size="s" spin={sampling} />Play a sample</button>
                {activeProfile && !usesIt && <button className="btn btn-sm btn-primary" onClick={onUse}>Use this voice</button>}
              </span>
            </>
          ) : (
            <>
              <span className="drawer-live-text"><span className="live-dot" aria-hidden="true" />Waiting for {label} on this computer. <span className="setting-desc">Checks every 2 seconds while this panel is open.</span></span>
              <span className="drawer-live-actions"><button className="btn btn-sm btn-ghost" onClick={() => recheck()}><Icon name="refresh" size="s" />Check again</button></span>
            </>
          )}
        </footer>
      </aside>
    </div>
  );
}

// An engine that isn't running, above its voice list.
function EngineSetupInline({ engine, state, onSetup }) {
  return (
    <div className="voices-offline-banner">
      <Icon name="warn" size="s" />
      <span>{engineLabel(engine)}: {STATUS_LABEL[state]}. Its voices show once it runs.</span>
      <button className="btn btn-ghost btn-sm" onClick={() => onSetup(engine)}>{state === 'missing' ? 'Set up' : 'How to start'}</button>
    </div>
  );
}

// The profile form's voice: engine pills, then a dropdown of that engine's
// voices with search, language, favorites and samples.
function VoiceField({ draft, rows, engines, favoritesByEngine, previewKey, onChange, onFavorite, onPreview, onSetup }) {
  const engine = draft.engine || 'browser';
  const state = engines[engine]?.state || 'checking';
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = rows.find((r) => r.engine === engine && r.id === (draft.voice || ''))
    || rowForProfile(rows, { engine, voice: draft.voice }, {});
  return (
    <div className="voice-field" ref={boxRef}>
      <EnginePills engines={engines} value={engine} onChange={(id) => { onChange(id, ''); setOpen(true); }} />
      <button type="button" className="vf-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="vf-name">{current.name}</span>
        <span className="vf-meta">{current.meta}</span>
        <Icon name="chevron-down" size="s" />
      </button>
      {open && (
        <div className="vf-pop">
          <VoiceList
            rows={rows}
            engine={engine}
            state={state}
            favorites={favoritesFor(favoritesByEngine, engine)}
            currentKey={voiceKey(current)}
            previewKey={previewKey}
            onChoose={(row) => { onChange(row.engine, row.id); setOpen(false); }}
            onFavorite={row => (row.engine === 'browser' ? null : onFavorite(row))}
            onPreview={onPreview}
            onSetup={onSetup}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<OptionsApp />);
