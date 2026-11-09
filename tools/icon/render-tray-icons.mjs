// Renders the VoiceDock tray icons (servers/piper/tray/assets/online|offline
// .png and .ico) from the mark, so the tray matches the extension icon.
//
//   node tools/icon/render-tray-icons.mjs
//
// The tray shows the Piper server's state on the mark's dock line: green when
// Piper answers, grey (with dimmed bars) when it doesn't. Small sizes use the
// pixel-grid drawings (16 and 32 px), as the toolbar icons do, so the bars stay
// sharp in the Windows notification area. The .ico holds a PNG per size.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const iconDir = join(repoRoot, 'tools', 'icon');
const outDir = join(repoRoot, 'servers', 'piper', 'tray', 'assets');

const STATES = {
  online: { top: '#c4b5fd', bottom: '#7c5cff', barOpacity: 1, dock: '#3ddc97' },
  offline: { top: '#8a84ad', bottom: '#5b5582', barOpacity: 0.75, dock: '#6e6a8c' },
};

// The mark's source drawing for this size (tools/icon/*.svg), recolored for
// the state: its bars' violet ramp, and its light dock line.
function markSvg(state, size) {
  const s = STATES[state];
  const file = size <= 16 ? 'voicedock-16.svg' : size <= 32 ? 'voicedock-32.svg' : 'voicedock.svg';
  const svg = readFileSync(join(iconDir, file), 'utf8')
    .replace('#c4b5fd', s.top)
    .replace('#7c5cff', s.bottom)
    .replace('#ede9fe', s.dock)
    .replace(/<g fill="url\(#([\w-]+)\)">/, `<g fill="url(#$1)" opacity="${s.barOpacity}">`);
  if (!svg.includes(s.dock) || !svg.includes(`opacity="${s.barOpacity}"`)) throw new Error(`${file} no longer has the colors this script recolors`);
  return svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
}

// An .ico whose entries are PNGs (supported since Windows Vista).
function icoFromPngs(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const PNG_SIZE = 128; // macOS and Linux trays scale this

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(state, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${markSvg(state, size)}`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

mkdirSync(outDir, { recursive: true });
for (const state of Object.keys(STATES)) {
  const entries = [];
  for (const size of ICO_SIZES) entries.push({ size, png: await render(state, size) });
  writeFileSync(join(outDir, `${state}.ico`), icoFromPngs(entries));
  writeFileSync(join(outDir, `${state}.png`), await render(state, PNG_SIZE));
  console.log(`${state}: .ico (${ICO_SIZES.join(', ')} px) and .png (${PNG_SIZE} px)`);
}
await browser.close();
