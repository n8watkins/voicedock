// The voice catalog the popup's picker shows: every engine's voices as rows
// with a friendly name, a one-line description, a language to filter on and
// an optional tag. Pure, so it is tested without a browser.
import { describeLocale, engineLabel, kokoroVoiceDetails, piperVoiceDetails, pocketVoiceDetails } from './shared.js';

export const ENGINE_ORDER = ['piper', 'kokoro', 'pocket', 'browser'];

// System voice names often repeat their language ("Microsoft Zira - English
// (United States)"); the language shows on its own line.
function systemVoiceName(voiceName) {
  return String(voiceName || '').replace(/\s+[-–]\s+.*\(.*\)\s*$/, '').trim() || voiceName;
}

// piper / kokoro / pocket: voice ids from each engine's voices list.
// browser: chrome.tts.getVoices() results; online (remote) voices are left out,
// because they send the text to a server and VoiceDock reads on this device.
export function buildVoiceCatalog({ piper = [], kokoro = [], pocket = [], browser = [] } = {}) {
  const rows = [];
  for (const id of piper) {
    const d = piperVoiceDetails(id);
    rows.push({ engine: 'piper', id, name: d?.name || id, meta: d?.language || '', language: d?.baseLanguage || 'Other', tag: d?.quality || '' });
  }
  for (const id of kokoro) {
    const d = kokoroVoiceDetails(id);
    rows.push({ engine: 'kokoro', id, name: d?.name || id, meta: d ? `${d.language} · ${d.gender}` : '', language: d?.baseLanguage || 'Other', tag: '' });
  }
  for (const id of pocket) {
    const d = pocketVoiceDetails(id);
    rows.push({ engine: 'pocket', id, name: d?.name || id, meta: d ? [d.language, d.accent].filter(Boolean).join(' · ') : '', language: d?.baseLanguage || 'Other', tag: '' });
  }
  rows.push({ engine: 'browser', id: '', name: 'Automatic', meta: 'The best voice on this device', language: '', tag: '' });
  const seen = new Set();
  for (const v of browser) {
    if (!v?.voiceName || v.remote === true || seen.has(v.voiceName)) continue;
    seen.add(v.voiceName);
    const locale = describeLocale(v.lang);
    rows.push({ engine: 'browser', id: v.voiceName, name: systemVoiceName(v.voiceName), meta: v.lang ? locale.language : 'On this device', language: v.lang ? locale.baseLanguage : 'Other', tag: 'System' });
  }
  return rows;
}

export function voiceKey(row) {
  return `${row.engine}:${row.id}`;
}

export function languagesIn(rows) {
  return [...new Set(rows.map((r) => r.language).filter((l) => l && l !== 'Other'))].sort();
}

// Search matches the name, the description and the engine; the language
// filter matches the base language ("English" covers US and UK).
export function filterVoices(rows, { query = '', language = '' } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (language && r.language !== language && !(r.engine === 'browser' && r.id === '')) return false;
    if (!q) return true;
    return `${r.name} ${r.meta} ${engineLabel(r.engine)}`.toLowerCase().includes(q);
  });
}

// The row for a profile's current voice, or a stand-in when the engine hasn't
// listed its voices (yet).
export function rowForProfile(rows, profile, defaultVoiceByEngine = {}) {
  const engine = profile?.engine || 'browser';
  const id = profile?.voice || (engine === 'browser' ? '' : defaultVoiceByEngine[engine] || '');
  const found = rows.find((r) => r.engine === engine && r.id === id);
  if (found) return found;
  if (engine === 'piper' && id) return buildVoiceCatalog({ piper: [id] })[0];
  if (engine === 'kokoro' && id) return buildVoiceCatalog({ kokoro: [id] })[0];
  if (engine === 'pocket' && id) return buildVoiceCatalog({ pocket: [id] })[0];
  if (engine === 'browser' && id) return { engine, id, name: id, meta: 'On this device', language: 'Other', tag: '' };
  return { engine, id: '', name: engine === 'browser' ? 'Basic voice' : 'Default voice', meta: engine === 'browser' ? 'On this device' : '', language: '', tag: '' };
}
