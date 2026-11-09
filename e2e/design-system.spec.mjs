// The design system on the settings page: one status vocabulary, SVG icons
// instead of glyphs, and the mark's palette in light and dark.
import { expect, onlyOnce, test } from './fixtures.mjs';

const piperRow = (page) => page.locator('.header-engine', { hasText: 'Piper' });
const kokoroRow = (page) => page.locator('.header-engine', { hasText: 'Kokoro' });

test('engines read Ready, Starting, Not running or Not installed', async ({ engines, openOptions }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  engines.kokoro.set('stopped');
  let page = await openOptions('engines');
  await expect(piperRow(page).locator('.vd-status')).toHaveText('Ready');
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Not installed');
  await page.close();

  // Set up, but the hub keeps it off (low memory).
  engines.kokoro.set('off');
  page = await openOptions('engines');
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Not running');
  await expect(page.locator('.engine-card[data-engine="kokoro"] .vd-status')).toHaveText('Installed but not running');

  engines.kokoro.set('starting');
  await page.getByRole('button', { name: 'Check again' }).first().click();
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Starting');
  engines.kokoro.set('running');
  await page.getByRole('button', { name: 'Check again' }).first().click();
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Ready');
});

test('an engine the hub reports set up is remembered, so with the hub down it is not running', async ({ engines, openOptions, serviceWorker }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  const page = await openOptions('engines');
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Ready');
  await expect.poll(async () => Object.keys(await serviceWorker.evaluate(async () => (await chrome.storage.local.get('engineSeen')).engineSeen || {})).sort()).toEqual(['kokoro', 'piper', 'pocket']);
  engines.piper.set('stopped'); // the whole hub is down
  await page.reload();
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Not running');
  await expect(piperRow(page).locator('.vd-status')).toHaveText('Not running');
});

test('no glyph icons are left on the settings page', async ({ openOptions }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  for (const tab of ['welcome', 'profiles', 'engines', 'shortcuts', 'about', 'credits']) {
    const page = await openOptions(tab);
    await expect(page.locator('.tab-panel')).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text, tab).not.toMatch(/[▶■⚙★☆↗✓✗⚠＋‹›]/);
    expect(text, tab).not.toMatch(/piper[ _-]?tts/i);
    await page.close();
  }
});

// Wide (the side nav and up to 830 px of content) and narrow (the nav becomes
// a row of tabs).
for (const [tab, width] of [['welcome', 1100], ['profiles', 1100], ['engines', 1100], ['shortcuts', 1100], ['credits', 1100], ['engines', 700]]) {
  const name = width === 1100 ? tab : `${tab}-narrow`;
  test(`settings page: ${name}`, async ({ openOptions, seed }) => {
    await seed({
      profiles: [
        { id: 'a', name: 'Articles', engine: 'piper', voice: 'en_US-ryan-high.onnx', rate: 1.2, volume: 1 },
        { id: 'b', name: 'Long reads', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1.1 },
      ],
      activeId: 'a',
      favoritesByEngine: { piper: ['en_US-ryan-high.onnx'], kokoro: [] },
    });
    const page = await openOptions(tab, { width, height: 900 });
    await expect(page.locator('.header-engine .vd-status.ready')).toHaveCount(2);
    if (tab === 'engines') await expect(page.locator('.voice-card')).toHaveCount(5);
    await expect(page).toHaveScreenshot(`options-${name}.png`, { fullPage: true });
  });
}

// The guided setup panel, for the review screenshots: Kokoro not set up,
// and Kokoro set up but kept off.
for (const [name, mode] of [['setup-kokoro', 'stopped'], ['start-kokoro', 'off']]) {
  test(`setup panel: ${name}`, async ({ engines, openOptions, seed }) => {
    await seed({ profiles: [{ id: 'a', name: 'Articles', engine: 'piper', voice: 'en_US-ryan-high.onnx', rate: 1, volume: 1 }], activeId: 'a' });
    engines.kokoro.set(mode);
    const page = await openOptions('engines:kokoro');
    const drawer = page.getByRole('dialog');
    await expect(drawer.locator('.drawer-live')).toContainText('Waiting for Kokoro');
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
    await expect(page).toHaveScreenshot(`options-${name}.png`, { animations: 'disabled' });
  });
}

// Pocket TTS: its guided setup, and the engine history after a Pocket read.
test('setup panel: setup-pocket', async ({ engines, openOptions, seed }) => {
  await seed({ profiles: [{ id: 'a', name: 'Articles', engine: 'piper', voice: 'en_US-ryan-high.onnx', rate: 1, volume: 1 }], activeId: 'a' });
  engines.pocket.set('stopped');
  const page = await openOptions('engines:pocket');
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('node engines.js install pocket');
  await expect(drawer).toContainText('node engines.js model pocket');
  await expect(drawer.locator('.drawer-live')).toContainText('Waiting for Pocket TTS');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
  await expect(page).toHaveScreenshot('options-setup-pocket.png', { animations: 'disabled' });
});

test('engine history: Pocket voices and what the hub did', async ({ engines, openOptions, seed }) => {
  await seed({
    profiles: [{ id: 'a', name: 'Stories', engine: 'pocket', voice: 'marius', rate: 1, volume: 1 }],
    activeId: 'a',
  });
  await fetch('http://127.0.0.1:7477/engines/pocket/warm', { method: 'POST' });
  await expect.poll(() => engines.pocket.state.mode).toBe('running');
  engines.hub.events.push({ at: '2026-11-09T18:10:00.000Z', type: 'stop', engine: 'kokoro', reason: 'Pocket TTS became active' });
  const page = await openOptions('engines', { width: 1100, height: 900 });
  await page.getByRole('radio', { name: /Pocket/ }).click();
  await expect(page.locator('.voice-card')).toHaveCount(26);
  await page.getByText('Engine history').click();
  const history = page.locator('.history-list li');
  await expect(history).toHaveCount(3);
  await expect(history.first()).toContainText('Kokoro stopped: Pocket TTS became active');
  await expect(history.nth(1)).toContainText('Pocket TTS ready in 0.3 s');
  await page.locator('.engine-history').scrollIntoViewIfNeeded();
  await expect(page.locator('.engine-history')).toHaveScreenshot('options-engine-history.png', { mask: [page.locator('.history-list time')] });
});
