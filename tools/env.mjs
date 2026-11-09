// Settings the repo's tools read from the environment. Each is VOICEDOCK_<NAME>;
// the PIPER_TTS_<NAME> spelling from before the rename still works for one
// release, with a note saying which name to use instead.
const warned = new Set();

export function envSetting(name, env = process.env, warn = console.warn) {
  const current = env[`VOICEDOCK_${name}`];
  if (current !== undefined && current !== '') return current;
  const legacyName = `PIPER_TTS_${name}`; // legacy-name
  const legacy = env[legacyName];
  if (legacy !== undefined && legacy !== '') {
    if (!warned.has(legacyName)) {
      warned.add(legacyName);
      warn(`${legacyName} is the old name of VOICEDOCK_${name}; please rename it.`);
    }
    return legacy;
  }
  return undefined;
}
