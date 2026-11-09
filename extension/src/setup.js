// How to set up and start Piper and Kokoro, per OS: the one source for the
// guided setup panel (Voices & Engines and Get started) and the tests. README.md says the same in
// prose; keep them in step. Pure data, no JSX.

export const OS_IDS = ['windows', 'macos', 'linux'];
export const OS_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

// The OS this browser runs on, for the default tab ('windows' when unknown,
// since most users are there).
export function detectOs(nav = globalThis.navigator) {
  const platform = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '').toLowerCase();
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('linux') || platform.includes('x11') || platform.includes('cros')) return 'linux';
  return 'windows';
}

// A step: a short title, what it does in a few words, and the commands to
// copy (each line runs on its own, so PowerShell 5.1 works too).
const CLONE = {
  title: 'Get VoiceDock',
  what: 'Downloads the servers next to the extension.',
};

export const SETUP_STEPS = {
  piper: {
    windows: [
      { title: 'Install Node.js and Git', what: 'Skip if node -v prints 18 or newer.', commands: ['winget install -e --id OpenJS.NodeJS.LTS', 'winget install -e --id Git.Git'] },
      { ...CLONE, commands: ['git clone https://github.com/n8watkins/voicedock', 'cd voicedock\\servers\\piper'] },
      { title: 'Set up Piper', what: 'The local server, Piper and one voice (90 MB), run by a tray icon.', commands: ['npm run setup'] },
    ],
    macos: [
      { title: 'Install Node.js and Git', what: 'Skip if node -v prints 18 or newer.', commands: ['brew install node git'] },
      { ...CLONE, commands: ['git clone https://github.com/n8watkins/voicedock', 'cd voicedock/servers/piper'] },
      { title: 'Set up Piper', what: 'The local server, Piper and one voice (90 MB), run by a tray icon.', commands: ['npm run setup'] },
    ],
    linux: [
      { title: 'Install Node.js and Git', what: 'Needs Node 18+: Ubuntu 24.04 has it, older ones use nodejs.org.', commands: ['sudo apt install nodejs npm git'] },
      { ...CLONE, commands: ['git clone https://github.com/n8watkins/voicedock', 'cd voicedock/servers/piper'] },
      { title: 'Set up Piper', what: 'The local server, Piper and one voice (90 MB), run by a tray icon.', commands: ['npm run setup'] },
    ],
  },
  kokoro: {
    windows: [
      { title: 'Install uv', what: 'Runs Kokoro\'s Python. Skip if uv --version works.', commands: ['powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'] },
      { title: 'Set up Kokoro', what: 'Packages and the model (338 MB). Ends with "Kokoro is set up."', commands: ['cd voicedock\\servers\\kokoro', 'powershell -ExecutionPolicy Bypass -File setup.ps1'] },
      { title: 'Restart VoiceDock\'s server', what: 'Tray icon, then Restart. It starts Kokoro when you read.' },
    ],
    macos: [
      { title: 'Install uv', what: 'Runs Kokoro\'s Python. Skip if uv --version works.', commands: ['curl -LsSf https://astral.sh/uv/install.sh | sh'] },
      { title: 'Set up Kokoro', what: 'Packages and the model (338 MB). Ends with "Kokoro is set up."', commands: ['cd voicedock/servers/kokoro', './setup.sh'] },
      { title: 'Restart VoiceDock\'s server', what: 'Tray icon, then Restart. It starts Kokoro when you read.' },
    ],
    linux: [
      { title: 'Install uv', what: 'Runs Kokoro\'s Python. Skip if uv --version works.', commands: ['curl -LsSf https://astral.sh/uv/install.sh | sh'] },
      { title: 'Set up Kokoro', what: 'Packages and the model (338 MB). Ends with "Kokoro is set up."', commands: ['cd voicedock/servers/kokoro', './setup.sh'] },
      { title: 'Restart VoiceDock\'s server', what: 'Tray icon, then Restart. It starts Kokoro when you read.' },
    ],
  },
};

// What each engine needs first, and how to tell setup worked.
export const SETUP_FACTS = {
  piper: { needs: 'Node.js 18+', size: '90 MB', worked: 'Piper shows Ready here.' },
  kokoro: { needs: 'Piper set up first (its server runs Kokoro), and uv', size: '338 MB', worked: 'Kokoro shows Starts when you read here.' },
};

// How to start an engine that is set up but not running ("Installed but not
// running"): both run through VoiceDock's local server, so it comes first.
const START_SERVER = {
  windows: { title: 'Start VoiceDock\'s server', what: 'Tray icon, then Start. No icon? Run this and keep the window open.', commands: ['cd voicedock\\servers\\piper', 'npm start'] },
  macos: { title: 'Start VoiceDock\'s server', what: 'Menu bar icon, then Start. No icon? Run this and keep it open.', commands: ['cd voicedock/servers/piper', 'npm start'] },
  linux: { title: 'Start VoiceDock\'s server', what: 'Tray icon, then Start. No icon? Run this and keep the window open.', commands: ['cd voicedock/servers/piper', 'npm start'] },
};
export const START_STEPS = {
  piper: {
    windows: [START_SERVER.windows],
    macos: [START_SERVER.macos],
    linux: [START_SERVER.linux],
  },
  kokoro: {
    windows: [
      START_SERVER.windows,
      { title: 'Still not running?', what: 'Run Kokoro\'s setup again, then Restart from the tray icon.', commands: ['cd voicedock\\servers\\kokoro', 'powershell -ExecutionPolicy Bypass -File setup.ps1'] },
    ],
    macos: [
      START_SERVER.macos,
      { title: 'Still not running?', what: 'Run Kokoro\'s setup again, then Restart from the menu bar icon.', commands: ['cd voicedock/servers/kokoro', './setup.sh'] },
    ],
    linux: [
      START_SERVER.linux,
      { title: 'Still not running?', what: 'Run Kokoro\'s setup again, then Restart from the tray icon.', commands: ['cd voicedock/servers/kokoro', './setup.sh'] },
    ],
  },
};

export function startSteps(engine, os) {
  return START_STEPS[engine]?.[os] || [];
}

// What "Installed but not running" means, per engine.
export const NOT_RUNNING_HELP = {
  piper: { means: 'Piper is set up, but VoiceDock\'s server is not running.' },
  kokoro: { means: 'Kokoro is set up, but VoiceDock\'s server is not running or keeps it off for now.' },
};

export function setupSteps(engine, os) {
  return SETUP_STEPS[engine]?.[os] || [];
}
