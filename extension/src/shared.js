// Shared by the service worker (background.js imports this file directly) and
// the React UI bundles, so engine URLs, the seed profile, and the settings
// migration can't drift between them. Keep it free of JSX and DOM APIs.

export const APP_NAME = 'VoiceDock';

// ─── Engines ─────────────────────────────────────────────────────────────────
// Piper and Kokoro are local servers speaking the same API (docs/API.md);
// "browser" is the Basic voice: Chrome's built-in speech (chrome.tts), which
// needs no setup and is what a new install reads with.
export const ENGINES = {
  piper: {
    id: 'piper',
    label: 'Piper',
    mono: 'Pi',
    baseUrl: 'http://127.0.0.1:7477',
    local: true,
    blurb: 'The light default: fast local voices, about 20 MB of RAM when idle (Node.js server on port 7477).',
  },
  kokoro: {
    id: 'kokoro',
    label: 'Kokoro',
    mono: 'Ko',
    baseUrl: 'http://127.0.0.1:7478',
    local: true,
    blurb: 'Optional: more natural voices in 9 languages, for a 338 MB one-time download and about 300-700 MB of RAM while its model is loaded (it is released after 10 idle minutes). Needs Python, in WSL on Windows (port 7478).',
  },
  browser: {
    id: 'browser',
    label: 'Basic voice',
    mono: 'Ba',
    baseUrl: null,
    local: false,
    blurb: "Chrome's built-in speech: no setup, always available, and the fallback when Piper or Kokoro isn't running. VoiceDock picks a voice that runs on this device.",
  },
};
export const ENGINE_IDS = ['piper', 'kokoro', 'browser'];
export const LOCAL_ENGINE_IDS = ['piper', 'kokoro'];

export const PIPER_BASE_URL = ENGINES.piper.baseUrl;
export const KOKORO_BASE_URL = ENGINES.kokoro.baseUrl;

// ─── Engine state: one vocabulary everywhere ────────────────────────────────
// Ready: answers /health. Starting: answers, but is still loading its model.
// Installed but not running: it answered at least once before (remembered in
// storage under ENGINE_SEEN_KEY), but not now. Not installed: it never has.
// Checking: no answer yet on this page. The Basic voice is always Ready.
export const ENGINE_STATES = ['ready', 'starting', 'stopped', 'missing', 'checking'];
export const STATUS_LABEL = {
  ready: 'Ready',
  starting: 'Starting',
  stopped: 'Installed but not running',
  missing: 'Not installed',
  checking: 'Checking',
};
export const STATUS_SHORT = { ...STATUS_LABEL, stopped: 'Not running' };
export const ENGINE_SEEN_KEY = 'engineSeen';

// health: the engine's /health JSON, null when it didn't answer, undefined
// while the check is in flight. seen: when it last answered (any truthy value).
export function engineState(id, health, seen) {
  if (id === 'browser') return 'ready';
  if (health === undefined) return 'checking';
  if (health) return health.modelLoading === true ? 'starting' : 'ready';
  return seen ? 'stopped' : 'missing';
}

// Records that an engine answered. Returns the new map, or null when nothing
// changed today (so callers write storage at most once a day per engine).
export function markEngineSeen(seenMap, id, now = new Date()) {
  const map = seenMap && typeof seenMap === 'object' ? seenMap : {};
  const day = now.toISOString().slice(0, 10);
  if (typeof map[id] === 'string' && map[id].slice(0, 10) === day) return null;
  return { ...map, [id]: now.toISOString() };
}

// GET <engine>/health. Resolves to its JSON (or { status: 'ok' } from a server
// that answers without JSON), or null when the engine doesn't answer.
export async function probeEngine(id, { fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  const baseUrl = engineBaseUrl(id);
  if (!baseUrl) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    try {
      const body = await res.json();
      return body && typeof body === 'object' ? body : { status: 'ok' };
    } catch (_) {
      return { status: 'ok' };
    }
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

export function engineBaseUrl(id) {
  return isEngine(id) ? ENGINES[id].baseUrl : null;
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
export function chooseEngine(profile, onlineByEngine, fallback = true) {
  const p = normalizeProfile(profile);
  if (p.engine === 'browser') {
    return { engine: 'browser', voice: '', fellBack: false, reason: '' };
  }
  if (onlineByEngine?.[p.engine]) {
    return { engine: p.engine, voice: p.voice, fellBack: false, reason: '' };
  }
  const reason = `${engineLabel(p.engine)} is offline`;
  if (fallback) return { engine: 'browser', voice: '', fellBack: true, reason };
  return { engine: null, voice: '', fellBack: false, reason };
}
