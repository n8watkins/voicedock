// Shared by the service worker (background.js imports this file directly) and
// the React UI bundles, so engine URLs, the seed profile, and the settings
// migration can't drift between them. Keep it free of JSX and DOM APIs.

export const APP_NAME = 'VoiceDock';

// ─── Engines ─────────────────────────────────────────────────────────────────
// Piper and Kokoro run on this computer behind one local server, the VoiceDock
// hub on 127.0.0.1:7477 (docs/API.md). The extension talks only to the hub:
// GET /engines says what is set up and what runs, and every read goes to its
// POST /tts with the engine's id, so a new engine never needs a new host
// permission. "browser" is the Basic voice: Chrome's built-in speech
// (chrome.tts), which needs no setup and is what a new install reads with.
export const HUB_URL = 'http://127.0.0.1:7477';
export const HUB_API = 2; // GET /engines answers { api: 2, engines: [...] }
export const TTS_URL = `${HUB_URL}/tts`;

export const ENGINES = {
  piper: {
    id: 'piper',
    label: 'Piper',
    mono: 'Pi',
    local: true,
    blurb: 'Fast, light local voices.',
    short: 'Natural and light: about 20 MB idle.',
    facts: { memory: '20 MB idle, 60-150 MB reading', download: '90 MB with one voice' },
  },
  kokoro: {
    id: 'kokoro',
    label: 'Kokoro',
    mono: 'Ko',
    local: true,
    blurb: 'The most natural voices, 54 in 9 languages.',
    short: 'Most natural: runs only while you read.',
    facts: { memory: '500-600 MB reading, none idle', download: '338 MB' },
  },
  browser: {
    id: 'browser',
    label: 'Basic voice',
    mono: 'Ba',
    local: false,
    blurb: "Chrome's built-in speech, the fallback.",
    short: 'Built into Chrome. No setup.',
    facts: { memory: 'none', download: 'none' },
  },
};
export const ENGINE_IDS = ['piper', 'kokoro', 'browser'];
export const LOCAL_ENGINE_IDS = ['piper', 'kokoro'];

// ─── Engine state: one vocabulary everywhere ────────────────────────────────
// The hub reports each engine's state; these are the words people see.
// Ready: can read now. Starting: starting, or loading its model. Standby
// (Starts when you read): set up, not running, and the hub starts it on the
// first read. Installed but not running: set up, but the hub is not running
// (or keeps it off: low memory, repeated crashes). Not installed: not set up.
// Checking: no answer yet on this page. The Basic voice is always Ready.
export const ENGINE_STATES = ['ready', 'starting', 'standby', 'stopped', 'missing', 'checking'];
export const STATUS_LABEL = {
  ready: 'Ready',
  starting: 'Starting',
  standby: 'Starts when you read',
  stopped: 'Installed but not running',
  missing: 'Not installed',
  checking: 'Checking',
};
export const STATUS_SHORT = { ...STATUS_LABEL, standby: 'Standby', stopped: 'Not running' };
// States in which an engine can read now (standby starts on the first read).
export function engineUsable(state) {
  return state === 'ready' || state === 'starting' || state === 'standby';
}
export const ENGINE_SEEN_KEY = 'engineSeen';

// The hub's state words (the N8 Tray contract's vocabulary) in the
// extension's.
const HUB_STATE = {
  ready: 'ready',
  starting: 'starting',
  idle: 'standby',
  stopped: 'stopped',
  failed: 'stopped',
  busy: 'starting',
  'not-installed': 'missing',
  'needs-setup': 'missing',
  unsupported: 'missing',
};

// GET /engines on the hub. Resolves to
//   { reachable: true, api, engines: { id: entry }, presence, pressure }
// or { reachable: false, api: 0, engines: {} } when the hub doesn't answer.
// A hub from before the hub API (VoiceDock 1.1's Piper server) is api 1.
export async function fetchEngines({ fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${HUB_URL}/engines`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return { reachable: true, api: 1, engines: {} };
    const body = await res.json();
    const list = Array.isArray(body?.engines) ? body.engines : [];
    return {
      reachable: true,
      api: Number.isInteger(body?.api) ? body.api : 1,
      engines: Object.fromEntries(list.filter((e) => e && typeof e.id === 'string').map((e) => [e.id, e])),
      presence: body?.presence || null,
      pressure: typeof body?.pressure === 'string' ? body.pressure : 'ok',
    };
  } catch (_) {
    return { reachable: false, api: 0, engines: {} };
  } finally {
    clearTimeout(timer);
  }
}

// hub: what fetchEngines resolved to, or undefined while it is in flight.
// seen: whether this engine was ever set up (remembered in storage under
// ENGINE_SEEN_KEY), which only matters while the hub is not running.
export function engineState(id, hub, seen) {
  if (id === 'browser') return 'ready';
  if (hub === undefined) return 'checking';
  if (!hub.reachable) return seen ? 'stopped' : 'missing';
  if (hub.api < HUB_API) {
    // An older Piper server: Piper reads, nothing else can be reached.
    if (id === 'piper') return 'ready';
    return seen ? 'stopped' : 'missing';
  }
  const entry = hub.engines[id];
  return entry ? HUB_STATE[entry.state] || 'stopped' : 'missing';
}

// Whether the hub says this engine is set up (to remember it as seen).
export function engineInstalled(id, hub) {
  return Boolean(hub?.reachable && hub.api >= HUB_API && hub.engines[id]?.installed);
}

// One plain line on why an engine is in its state, for cards and notes.
export function engineDetail(id, hub, state = engineState(id, hub, false)) {
  if (id === 'browser') return 'Built into Chrome.';
  const label = engineLabel(id);
  if (!hub || state === 'checking') return '';
  if (!hub.reachable) {
    return state === 'stopped' ? "VoiceDock's local server is not running." : `${label} is not set up on this computer.`;
  }
  if (hub.api < HUB_API && id !== 'piper') return `Update VoiceDock's local server to read with ${label}.`;
  return hub.engines[id]?.detail || '';
}

// Why an engine can't read right now, as the start of a sentence:
// "Kokoro is not running", "Kokoro is not set up".
export function unavailableReason(id, state) {
  const label = engineLabel(id);
  return state === 'missing' ? `${label} is not set up` : `${label} is not running`;
}

// About how long until an engine reads after a cold start, in whole seconds:
// the hub's measured figure for this computer, else its estimate.
export function startSeconds(id, hub) {
  const ms = hub?.engines?.[id]?.coldStart?.estimateMs;
  return Math.max(1, Math.round((Number.isFinite(ms) ? ms : 5000) / 1000));
}

export function startingText(id, hub) {
  return `Starting ${engineLabel(id)}, about ${startSeconds(id, hub)} s`;
}

// ─── Notes on the page ───────────────────────────────────────────────────────
// When an engine can't read, the player bar says so and keeps the note until
// it is dismissed. Amber (warn): VoiceDock still reads, with the Basic voice.
// Red (err): nothing can read. Each note has at most one fix: a link to the
// engine's guided setup (options.html#engines:<id>).
//   { tone: 'warn' | 'err', text, fix: { label, engine } | null }
//
// when: 'start' (the engine couldn't read when the read began) or 'mid' (it
// stopped while reading). reason: the hub's "not-installed", "low-memory" or
// "failed", or ''. state: the engine's state word, when known.
export function readNote({ engine, when = 'start', reason = '', state = '', fellBack = true }) {
  const label = engineLabel(engine);
  const missing = reason === 'not-installed' || state === 'missing';
  let first;
  if (reason === 'low-memory') first = `Memory is low, so ${label} ${when === 'mid' ? 'stopped' : 'is off for now'}.`;
  else if (missing) first = `${label} is not set up.`;
  else first = when === 'mid' ? `${label} stopped.` : `${label} is not running.`;
  const fix = reason === 'low-memory' ? null : { label: missing ? `Set up ${label}` : 'How to start', engine };
  if (fellBack) {
    return { tone: 'warn', text: `${first} ${when === 'mid' ? 'Reading on' : 'Reading'} with the Basic voice.`, fix };
  }
  // Red: say what happened and why nothing reads on, in one sentence.
  return { tone: 'err', text: `${first.replace(/\.$/, '')}${when === 'mid' && !missing && reason !== 'low-memory' ? ' while reading' : ''}, and the Basic voice fallback is off.`, fix };
}

// The Basic voice itself failed (a chrome.tts error), or this computer has no
// voice for it at all.
export function basicVoiceNote({ error = '', noVoices = false } = {}) {
  if (noVoices) {
    return { tone: 'err', text: 'Nothing to read with. This computer has no built-in voice, and no engine is ready.', fix: { label: 'Set up Piper', engine: 'piper' } };
  }
  const why = String(error || '').trim().replace(/\.$/, '');
  return { tone: 'err', text: `The Basic voice could not read this${why ? `: ${why}` : ''}.`, fix: null };
}

// Where an engine's voices are listed: the hub lists Kokoro's from its voices
// file, so this never starts Kokoro.
export function voicesUrl(id) {
  if (id === 'piper') return `${HUB_URL}/voices`;
  return isEngine(id) && ENGINES[id].local ? `${HUB_URL}/engines/${id}/voices` : null;
}

// Records that an engine is set up. Returns the new map, or null when nothing
// changed today (so callers write storage at most once a day per engine).
export function markEngineSeen(seenMap, id, now = new Date()) {
  const map = seenMap && typeof seenMap === 'object' ? seenMap : {};
  const day = now.toISOString().slice(0, 10);
  if (typeof map[id] === 'string' && map[id].slice(0, 10) === day) return null;
  return { ...map, [id]: now.toISOString() };
}

export function engineMono(id) {
  return isEngine(id) ? ENGINES[id].mono : '··';
}

export const MAX_PROFILES = 5;
export const MAX_FAVORITES = 5; // per engine
export const SETTINGS_VERSION = 2;

export function isEngine(id) {
  return Object.prototype.hasOwnProperty.call(ENGINES, id);
}

export function engineLabel(id) {
  return isEngine(id) ? ENGINES[id].label : 'Unknown engine';
}

// Profiles saved before engines existed only have a voice: an empty voice was
// the browser voice and every other voice was a Piper .onnx file. Kokoro voice
// ids look like "af_heart".
export function inferEngine(voice) {
  if (!voice) return 'browser';
  if (/\.onnx$/i.test(voice)) return 'piper';
  return 'kokoro';
}

function clampNumber(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Returns a profile with every field present and valid. Never mutates.
export function normalizeProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const voice = typeof p.voice === 'string' ? p.voice : '';
  const engine = isEngine(p.engine) ? p.engine : inferEngine(voice);
  return {
    ...p,
    id: typeof p.id === 'string' && p.id ? p.id : uuid(),
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Profile',
    engine,
    // The Basic voice keeps a system voice name, never an engine's voice id.
    voice: engine === 'browser' && (/\.onnx$/i.test(voice) || /^[a-z][fm]_/.test(voice)) ? '' : voice,
    rate: clampNumber(p.rate, 0.5, 2.5, 1.0),
    volume: clampNumber(p.volume, 0, 2, 1.0),
  };
}

export function defaultProfile() {
  return { id: 'default', name: 'Profile 1', engine: 'browser', voice: '', rate: 1.0, volume: 1.0 };
}

// ─── Settings migration ──────────────────────────────────────────────────────
// Pure: takes everything in chrome.storage.local and returns what to write and
// what to remove. Safe to run any number of times (idempotent), from the
// service worker on install/update/startup and from the UI pages on load.
//
// v1 (<= 1.0.x, before the VoiceDock name) → v2 (VoiceDock 1.1):
//   fallbackToBrowser    → fallback
//   profiles[].voice     → profiles[].engine + voice (engine inferred)
//   profile "Default"    → "Profile 1" (the seed profile's old name)
//   favorites (one list) → favoritesByEngine { piper, kokoro }
export function migrateSettings(raw = {}) {
  const set = {};
  const remove = [];

  if (raw.fallbackToBrowser !== undefined) {
    if (raw.fallback === undefined) set.fallback = raw.fallbackToBrowser !== false;
    remove.push('fallbackToBrowser');
  }

  if (Array.isArray(raw.profiles)) {
    const profiles = raw.profiles.map((profile) => {
      const next = normalizeProfile(profile);
      if (next.id === 'default' && next.name === 'Default') next.name = 'Profile 1';
      return next;
    });
    if (JSON.stringify(profiles) !== JSON.stringify(raw.profiles)) set.profiles = profiles;
  }

  const byEngine = raw.favoritesByEngine && typeof raw.favoritesByEngine === 'object'
    ? raw.favoritesByEngine
    : null;
  if (raw.favorites !== undefined) {
    // Merge rather than overwrite, so a legacy list is never lost even if
    // favoritesByEngine was already seeded (for example by a migration that
    // ran on an empty store moments before old settings were restored).
    const legacy = Array.isArray(raw.favorites) ? raw.favorites.filter((v) => typeof v === 'string') : [];
    const merged = {};
    for (const engine of LOCAL_ENGINE_IDS) {
      const existing = favoritesFor(byEngine, engine);
      const extra = legacy.filter((v) => inferEngine(v) === engine && !existing.includes(v));
      merged[engine] = [...existing, ...extra].slice(0, MAX_FAVORITES);
    }
    set.favoritesByEngine = merged;
    remove.push('favorites');
  } else if (!byEngine) {
    set.favoritesByEngine = { piper: [], kokoro: [] };
  }

  if (raw.settingsVersion !== SETTINGS_VERSION) set.settingsVersion = SETTINGS_VERSION;

  return { set, remove };
}

// Applies migrateSettings to chrome.storage.local (or any object with the same
// get/set/remove promise API). Returns the migrated snapshot.
export async function runSettingsMigration(storage) {
  const raw = await storage.get(null);
  const { set, remove } = migrateSettings(raw);
  if (Object.keys(set).length > 0) await storage.set(set);
  if (remove.length > 0) await storage.remove(remove);
  const next = { ...raw, ...set };
  for (const key of remove) delete next[key];
  return next;
}

export function favoritesFor(favoritesByEngine, engine) {
  const list = favoritesByEngine?.[engine];
  return Array.isArray(list) ? list : [];
}

// ─── Formatting ──────────────────────────────────────────────────────────────
export function fmt(value) {
  return Number.parseFloat(value).toFixed(1);
}

export function uuid() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Kokoro's first letter is the language (docs: hexgrad/Kokoro-82M VOICES.md).
const KOKORO_LANGUAGES = {
  a: 'US English',
  b: 'UK English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Portuguese',
  z: 'Mandarin',
};

// "af_heart" → { name: "Heart", language: "US English", gender: "female" }
export function kokoroVoiceDetails(voice) {
  const match = /^([a-z])([fm])_(.+)$/i.exec(voice || '');
  if (!match) return null;
  const [, lang, gender, rest] = match;
  const language = KOKORO_LANGUAGES[lang.toLowerCase()] || 'Other';
  return {
    name: rest.charAt(0).toUpperCase() + rest.slice(1),
    language,
    baseLanguage: language.replace(/^(US|UK) /, ''),
    gender: gender.toLowerCase() === 'f' ? 'female' : 'male',
  };
}

const PIPER_NAME_FIXES = { libritts: 'LibriTTS', libritts_r: 'LibriTTS R', ljspeech: 'LJSpeech', vctk: 'VCTK', hfc_female: 'HFC female', hfc_male: 'HFC male', l2arctic: 'L2-ARCTIC', arctic: 'ARCTIC' };
const QUALITY_NAMES = { x_low: 'Extra low', low: 'Low', medium: 'Medium', high: 'High' };

function displayName(type, code) {
  try { return new Intl.DisplayNames(['en'], { type }).of(code) || code; } catch (_) { return code; }
}

// A locale like "en_US" or "en-US" as people say it: "US English",
// "UK English", "Spanish (Spain)". baseLanguage is just "English".
export function describeLocale(locale) {
  const [lang = '', region = ''] = String(locale || '').split(/[-_]/);
  if (!lang) return { language: 'Other', baseLanguage: 'Other' };
  const baseLanguage = displayName('language', lang.toLowerCase());
  if (!region) return { language: baseLanguage, baseLanguage };
  const upper = region.toUpperCase();
  if (lang.toLowerCase() === 'en' && (upper === 'US' || upper === 'GB')) {
    return { language: `${upper === 'GB' ? 'UK' : 'US'} English`, baseLanguage };
  }
  return { language: `${baseLanguage} (${displayName('region', upper)})`, baseLanguage };
}

// "en_US-ryan-high.onnx" → { name: "Ryan", language: "US English",
// baseLanguage: "English", quality: "High" }
export function piperVoiceDetails(filename) {
  const parts = String(filename || '').replace(/\.onnx$/i, '').split('-');
  if (parts.length < 2) return null;
  const [locale, rawName, tier] = parts;
  const key = rawName.toLowerCase();
  const name = PIPER_NAME_FIXES[key]
    || key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { name, ...describeLocale(locale), quality: QUALITY_NAMES[(tier || '').toLowerCase()] || '' };
}

export function formatVoiceName(voice, empty = 'Chrome default voice') {
  if (!voice) return empty;
  if (inferEngine(voice) === 'kokoro') {
    const details = kokoroVoiceDetails(voice);
    return details ? `${details.name} · ${details.language}` : voice;
  }
  const details = piperVoiceDetails(voice);
  if (details && details.quality) return `${details.name} · ${details.quality}`;
  return details ? details.name : voice.replace(/\.onnx$/, '');
}

// One line for a profile's voice, e.g. "Kokoro · Heart · US English".
// compact drops the Kokoro language ("Kokoro · Heart") for the narrow popup.
export function describeProfileVoice(profile, { compact = false } = {}) {
  const p = normalizeProfile(profile);
  if (p.engine === 'browser') {
    if (p.voice) return compact ? 'Basic voice' : `Basic voice · ${p.voice}`;
    return compact ? 'Basic voice' : 'Basic voice · built into Chrome';
  }
  const kokoro = compact && p.engine === 'kokoro' ? kokoroVoiceDetails(p.voice) : null;
  const voiceName = kokoro ? kokoro.name : formatVoiceName(p.voice, 'default voice');
  return `${engineLabel(p.engine)} · ${voiceName}`;
}

export function qualityFromFilename(filename) {
  const base = filename.replace(/\.onnx$/, '');
  const parts = base.split('-');
  const tier = parts[parts.length - 1]?.toLowerCase();
  const map = { x_low: 'x_low', low: 'low', medium: 'med', high: 'high' };
  return map[tier] || null;
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

// ─── First run ───────────────────────────────────────────────────────────────
// What a new user runs to get Piper. Separate lines, not "&&", so it works in
// Windows PowerShell 5.1 as well as macOS and Linux shells.
export const PIPER_SETUP_COMMANDS = [
  'git clone https://github.com/n8watkins/voicedock',
  'cd voicedock/servers/piper',
  'npm run setup',
];
export const SETUP_GUIDE_URL = 'https://github.com/n8watkins/voicedock#piper-server';

// ─── Basic voice: prefer a voice that runs on this device ────────────────────
// chrome.tts.getVoices() lists the OS voices (remote: false) and, in Google
// Chrome, Google's online voices (remote: true). VoiceDock asks for an
// on-device voice in the user's language, then any on-device voice. Returns ''
// when there is none, and Chrome then uses its own default.
export function pickDeviceVoice(voices, lang = 'en-US') {
  const local = (Array.isArray(voices) ? voices : []).filter((v) => v && v.voiceName && v.remote !== true);
  if (local.length === 0) return '';
  const want = String(lang || '').toLowerCase();
  const base = want.split('-')[0];
  const langOf = (v) => String(v.lang || '').toLowerCase();
  const match = local.find((v) => langOf(v) === want)
    || local.find((v) => base && langOf(v).split('-')[0] === base)
    || local[0];
  return match.voiceName;
}

// ─── Sentences ───────────────────────────────────────────────────────────────
// VoiceDock reads (and counts, and skips) by sentence. A fragment too short to
// stand alone ("Dr.", "No.", "1.") joins the next one; a very long sentence
// breaks at a comma or semicolon so its audio starts quickly.
const MIN_SENTENCE = 16;
const MAX_SENTENCE = 320;

function splitLong(sentence) {
  if (sentence.length <= MAX_SENTENCE) return [sentence];
  const parts = [];
  let rest = sentence;
  while (rest.length > MAX_SENTENCE) {
    const window = rest.slice(0, MAX_SENTENCE);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    if (cut < MAX_SENTENCE / 3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = MAX_SENTENCE - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const raw = clean.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) || [clean];
  const merged = [];
  let carry = '';
  for (const piece of raw.map((p) => p.trim()).filter(Boolean)) {
    const joined = carry ? `${carry} ${piece}` : piece;
    if (joined.length < MIN_SENTENCE) { carry = joined; continue; }
    merged.push(joined);
    carry = '';
  }
  if (carry) {
    if (merged.length) merged[merged.length - 1] = `${merged[merged.length - 1]} ${carry}`;
    else merged.push(carry);
  }
  return merged.flatMap(splitLong);
}

// "Sentence 3 of 6", for the popup and the player bar.
export function sentenceLabel(progress) {
  const total = Number(progress?.total) || 0;
  const current = Number(progress?.current) || 0;
  if (!total || !current) return 'Starting';
  return total === 1 ? 'One sentence' : `Sentence ${Math.min(current, total)} of ${total}`;
}

// ─── Engine selection (pure, used by the service worker) ─────────────────────
// Decides how to speak for a profile given which local engines are up:
//   { engine: "piper" | "kokoro" | "browser", voice, fellBack, reason }
// A local engine that's offline falls back to the browser voice when the
// fallback setting is on; otherwise there's nothing to play (engine: null).
export function chooseEngine(profile, onlineByEngine, fallback = true, reasonByEngine = {}) {
  const p = normalizeProfile(profile);
  if (p.engine === 'browser') {
    return { engine: 'browser', voice: '', fellBack: false, reason: '' };
  }
  if (onlineByEngine?.[p.engine]) {
    return { engine: p.engine, voice: p.voice, fellBack: false, reason: '' };
  }
  const reason = reasonByEngine[p.engine] || `${engineLabel(p.engine)} is not running`;
  if (fallback) return { engine: 'browser', voice: '', fellBack: true, reason };
  return { engine: null, voice: '', fellBack: false, reason };
}
