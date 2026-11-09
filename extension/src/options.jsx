import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  piperVoiceDetails,
  LOCAL_ENGINE_IDS,
  MAX_FAVORITES,
  MAX_PROFILES,
  normalizeProfile,
  STATUS_LABEL,
  PIPER_BASE_URL,
  qualityFromFilename,
  runSettingsMigration,
  uuid,
  voicesUrl,
} from './shared.js';
import { EngineMono, EngineStatus, Icon, useEngines } from './ui.jsx';
import { EnginePills, VoiceList } from './picker.jsx';
import { detectOs, NOT_RUNNING_HELP, OS_IDS, OS_LABEL, SETUP_FACTS, setupSteps } from './setup.js';
import { buildVoiceCatalog, ENGINE_ORDER, rowForProfile, voiceKey } from './voices.js';

const TABS = ['welcome', 'profiles', 'voices', 'settings', 'about', 'credits'];
const TAB_META = {
  welcome: { label: 'Get started', icon: 'compass' },
  profiles: { label: 'Profiles', icon: 'users' },
  voices: { label: 'Voices', icon: 'wave' },
  settings: { label: 'Settings', icon: 'settings' },
  about: { label: 'How it works', icon: 'info' },
  credits: { label: 'Credits', icon: 'heart' },
};
const SAMPLE_TEXT = 'VoiceDock reads the text you select on any web page. Pick a few sentences, right-click, and choose Read selection.';
const CHROME_COMMANDS = [
  ['read-selection', 'Read or stop'],
  ['pause-resume', 'Pause or resume'],
];

// "#settings:kokoro" opens Settings with Kokoro's setup steps.
function routeFromHash() {
  const [route = '', engine = ''] = window.location.hash.replace(/^#\/?/, '').toLowerCase().split(':');
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
  const [setupEngine, setSetupEngine] = useState(() => routeFromHash().engine || 'piper');
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
  const { engines, recheck } = useEngines();
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
    const health = await recheck();
    return !!health[engine];
  }

  // Loads one engine's voice list. An offline engine keeps its last list (so
  // saved profile voices still show) and reports no error: the offline banner
  // already says what's wrong.
  async function fetchVoices(engine) {
    const online = await checkEngineStatus(engine);
    // Kokoro in standby: the Piper server lists its voices without starting it.
    const url = online ? voicesUrl(engine, 'ready') : engine === 'kokoro' ? voicesUrl(engine, 'standby') : null;
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
      if (route.engine) {
        setSetupEngine(route.engine);
        requestAnimationFrame(() => document.getElementById('setup')?.scrollIntoView({ block: 'start' }));
      }
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
    if (tab === 'voices') fetchVoices(voicesEngine);
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
        setWelcomeNote(`${response.error}. Turn on the Basic voice fallback in Settings to hear it.`);
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
      const res = await fetch(`${PIPER_BASE_URL}/voices/${encodeURIComponent(filename)}`, { method: 'DELETE' });
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
    fetch(`${PIPER_BASE_URL}/voices/open-folder`, { method: 'POST' }).catch(() => {});
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

  // Every voice the profile forms can pick, per engine. Piper and Kokoro also
  // get a "Default" row (their server's default voice).
  const catalog = useMemo(() => {
    const rows = buildVoiceCatalog({
      piper: voicesByEngine.piper || [],
      kokoro: voicesByEngine.kokoro || [],
      browser: browserVoices,
    });
    const defaults = LOCAL_ENGINE_IDS.map((engine) => ({
      engine, id: '', name: 'Default voice', meta: defaultVoiceByEngine[engine] ? formatVoiceName(defaultVoiceByEngine[engine]) : 'The server\'s default', language: '', tag: '',
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
    window.location.hash = `settings:${engine}`;
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
            <span key={engine} className="header-engine" title={ENGINES[engine].baseUrl}>
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
          <p className="panel-blurb">Reads selected text aloud. The <strong>Basic voice</strong> works now; <strong>Piper</strong> and <strong>Kokoro</strong> add natural voices that run on this computer.</p>

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

          {(!engineStatus.piper || !engineStatus.kokoro) && (
            <div className="settings-group">
              <h3 className="settings-group-title"><Icon name="terminal" size="s" />3. Add natural voices</h3>
              <SetupGuide engine={setupEngine === 'kokoro' || engineStatus.piper ? 'kokoro' : 'piper'} engines={engines} onEngine={setSetupEngine} />
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

      {tab === 'voices' && (
        <section className="tab-panel" role="tabpanel">
          <div className="panel-toolbar">
            <h2 className="panel-heading">Voices</h2>
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
                : (voicesEngine === 'piper' ? 'No voices yet. Add .onnx files to the voices folder.' : 'Kokoro listed no voices.'))}</p>
            )}
            {visibleVoices.map((voice) => {
              const isFav = viewFavorites.includes(voice);
              const quality = voicesEngine === 'piper' ? qualityFromFilename(voice) : null;
              const kokoro = voicesEngine === 'kokoro' ? kokoroVoiceDetails(voice) : null;
              const details = kokoro || piperVoiceDetails(voice);
              const isDefault = voice === defaultVoiceByEngine[voicesEngine];
              const settings = { engine: voicesEngine, voice };
              return (
                <div key={voice} className="voice-card" data-voice={voice}>
                  <button className={`voice-fav-btn ${isFav ? 'is-fav' : ''}`} title={isFav ? 'Remove from favorites' : 'Add to favorites'} aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={isFav} onClick={() => toggleFavorite(voicesEngine, voice)}><Icon name="star" /></button>
                  <div className="voice-card-info">
                    <span className="voice-card-name">
                      {kokoro ? kokoro.name : (piperVoiceDetails(voice)?.name || formatVoiceName(voice))}
                      {isDefault && <span className="lang-badge lang-badge-default">Default</span>}
                    </span>
                    <span className="voice-card-file">
                      {[details?.language, kokoro?.gender, quality && { x_low: 'Extra low', low: 'Low', med: 'Medium', high: 'High' }[quality], voicesEngine === 'piper' && formatBytes(voiceSizes[voice])].filter(Boolean).join(' · ')}
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
            {voicesEngine === 'piper'
              ? <a className="link-external" href="https://huggingface.co/rhasspy/piper-voices/tree/main/en" target="_blank">More Piper voices <Icon name="external" size="s" className="inline" /></a>
              : <a className="link-external" href="https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md" target="_blank">Kokoro voice grades <Icon name="external" size="s" className="inline" /></a>}
          </div>

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

      {tab === 'settings' && (
        <section className="tab-panel" role="tabpanel">
          <div className="panel-toolbar"><h2 className="panel-heading">Settings</h2></div>

          <h3 className="section-title"><Icon name="cpu" size="s" />Engines</h3>
          {/* Two columns: Piper and Kokoro are parallel, short cards worth comparing. */}
          <div className="engine-cards">
            {LOCAL_ENGINE_IDS.map((engine) => (
              <EngineCard
                key={engine}
                engine={engine}
                state={engines[engine].state}
                health={engines[engine].health}
                onCheck={() => fetchVoices(engine)}
                onSetup={() => { setSetupEngine(engine); document.getElementById('setup')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}
              />
            ))}
          </div>

          <h3 className="section-title" id="setup"><Icon name="terminal" size="s" />Set up or start an engine</h3>
          <div className="settings-group">
            <SetupGuide engine={setupEngine} engines={engines} onEngine={setSetupEngine} />
          </div>

          <h3 className="section-title"><Icon name="shield" size="s" />Reading</h3>
          <div className="settings-group">
            <label className="setting-row">
              <input type="checkbox" checked={fallback} onChange={(event) => {
                setFallback(event.target.checked);
                persist({ fallback: event.target.checked });
              }} />
              <div>
                <span className="setting-label">Basic voice fallback</span>
                <span className="setting-desc">Read with Chrome's voice when Piper or Kokoro can't.</span>
              </div>
            </label>
          </div>

          <h3 className="section-title"><Icon name="keyboard" size="s" />Shortcuts</h3>
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
            <li><span className="flow-step"><Icon name="cpu" size="s" /></span><div>Your profile's engine speaks it on this computer: <strong>Piper</strong> at <code>127.0.0.1:7477</code>, <strong>Kokoro</strong> at <code>127.0.0.1:7478</code>.</div></li>
            <li><span className="flow-step"><Icon name="wave" size="s" /></span><div>It reads <strong>sentence by sentence</strong>; the player bar on the page pauses, skips and stops.</div></li>
            <li><span className="flow-step"><Icon name="shield" size="s" /></span><div>An engine that can't read falls back to the <strong>Basic voice</strong> (Settings), and the page says so.</div></li>
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

      <Modal modal={modal} onConfirm={() => resolveModal(true)} onCancel={() => resolveModal(false)} />
    </div>
  );
}

const CREDITS = [
  { name: 'Piper', desc: 'Fast local speech, by rhasspy and OHF-Voice', href: 'https://github.com/OHF-Voice/piper1-gpl', mono: 'piper' },
  { name: 'Piper voices', desc: 'Voice models, on Hugging Face', href: 'https://huggingface.co/rhasspy/piper-voices', icon: 'mic' },
  { name: 'Kokoro-82M', desc: 'Natural open-weight voices, by hexgrad (Apache 2.0)', href: 'https://huggingface.co/hexgrad/Kokoro-82M', mono: 'kokoro' },
  { name: 'kokoro-onnx', desc: 'Runs Kokoro on ONNX Runtime, by thewh1teagle', href: 'https://github.com/thewh1teagle/kokoro-onnx', icon: 'cpu' },
  { name: 'uv', desc: 'Installs Kokoro\'s Python, by Astral', href: 'https://github.com/astral-sh/uv', icon: 'package' },
  { name: 'Lucide', desc: 'The icon style (ISC)', href: 'https://lucide.dev', icon: 'shapes' },
  { name: 'Onest, Bricolage Grotesque', desc: 'Typefaces (SIL OFL)', href: 'https://github.com/googlefonts/onest', icon: 'type' },
];

// One engine at a glance: status, address, memory, and the button that matters.
function EngineCard({ engine, state, health, onCheck, onSetup }) {
  const facts = ENGINES[engine].facts;
  const usable = engineUsable(state);
  return (
    <div className={`engine-card state-${state}`} data-engine={engine}>
      <div className="engine-card-head">
        <EngineMono engine={engine} />
        <div className="engine-card-title">
          <b>{engineLabel(engine)}</b>
          <EngineStatus state={state} />
        </div>
      </div>
      <dl className="engine-facts">
        <dt>Address</dt><dd><code>{ENGINES[engine].baseUrl.replace('http://', '')}</code></dd>
        <dt>Memory</dt><dd>{health?.rssMb ? `${Math.round(health.rssMb)} MB now · ` : ''}{facts.memory}</dd>
        <dt>Download</dt><dd>{facts.download}</dd>
      </dl>
      <div className="engine-card-actions">
        <button className="btn btn-ghost btn-sm" onClick={onCheck}><Icon name="refresh" size="s" />Check again</button>
        <button className={`btn btn-sm ${usable ? 'btn-ghost' : 'btn-primary'}`} onClick={onSetup}>
          <Icon name="terminal" size="s" />{state === 'missing' ? 'Set up' : usable ? 'Setup steps' : 'How to start'}
        </button>
      </div>
    </div>
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

// Numbered setup steps for one engine, with a tab per OS (this OS first
// selected), how to tell it worked, and what "Installed but not running" means.
function SetupGuide({ engine, engines, onEngine }) {
  const [os, setOs] = useState(detectOs);
  const steps = setupSteps(engine, os);
  const facts = SETUP_FACTS[engine];
  const help = NOT_RUNNING_HELP[engine];
  return (
    <div className="setup-guide">
      <div className="setup-tabs">
        {onEngine && <EnginePills engines={engines} ids={LOCAL_ENGINE_IDS} value={engine} onChange={onEngine} label="Engine to set up" />}
        <div className="os-tabs" role="tablist" aria-label="Your computer">
          {OS_IDS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={os === id} className={`os-tab${os === id ? ' active' : ''}`} onClick={() => setOs(id)}>
              <Icon name="monitor" size="s" />{OS_LABEL[id]}
            </button>
          ))}
        </div>
      </div>
      <p className="setup-facts">Needs {facts.needs} · {facts.size} download</p>
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
      <p className="setup-worked"><Icon name="check" size="s" /><span><b>Worked?</b> {facts.worked}</span></p>
      <div className="setup-states">
        <p><EngineStatus state="stopped" /> {help.means} {help.fix[os]}</p>
        {engine === 'kokoro' && <p><EngineStatus state="standby" /> Set up and fine: Piper starts it with your first Kokoro read.</p>}
        <p><EngineStatus state="missing" /> Never answered on this computer: follow the steps above.</p>
      </div>
    </div>
  );
}

// An engine that isn't running, on the Voices tab.
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
