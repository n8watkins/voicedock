// The design system on the settings page: one status vocabulary, SVG icons
// instead of glyphs, and the mark's palette in light and dark.
import { expect, onlyOnce, test } from './fixtures.mjs';

const piperRow = (page) => page.locator('.header-engine', { hasText: 'Piper' });
const kokoroRow = (page) => page.locator('.header-engine', { hasText: 'Kokoro' });

test('engines read Ready, Starting, Not running or Not installed', async ({ engines, openOptions }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  engines.kokoro.set('stopped');
  let page = await openOptions('settings');
  await expect(piperRow(page).locator('.vd-status')).toHaveText('Ready');
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Not installed');
  await page.close();

  // Set up, but the hub keeps it off (low memory).
  engines.kokoro.set('off');
  page = await openOptions('settings');
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Not running');
  await expect(page.locator('.engine-card[data-engine="kokoro"] .vd-status')).toHaveText('Installed but not running');

  engines.kokoro.set('starting');
  await page.getByRole('button', { name: 'Check again' }).nth(1).click();
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Starting');
  engines.kokoro.set('running');
  await page.getByRole('button', { name: 'Check again' }).nth(1).click();
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Ready');
});

test('an engine the hub reports set up is remembered, so with the hub down it is not running', async ({ engines, openOptions, serviceWorker }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  const page = await openOptions('settings');
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Ready');
  await expect.poll(async () => Object.keys(await serviceWorker.evaluate(async () => (await chrome.storage.local.get('engineSeen')).engineSeen || {})).sort()).toEqual(['kokoro', 'piper']);
  engines.piper.set('stopped'); // the whole hub is down
  await page.reload();
  await expect(kokoroRow(page).locator('.vd-status')).toHaveText('Not running');
  await expect(piperRow(page).locator('.vd-status')).toHaveText('Not running');
});

test('no glyph icons are left on the settings page', async ({ openOptions }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  for (const tab of ['welcome', 'profiles', 'voices', 'settings', 'about', 'credits']) {
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
for (const [tab, width] of [['welcome', 1100], ['profiles', 1100], ['voices', 1100], ['settings', 1100], ['credits', 1100], ['settings', 700]]) {
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
    if (tab === 'voices') await expect(page.locator('.voice-card')).toHaveCount(5);
    await expect(page).toHaveScreenshot(`options-${name}.png`, { fullPage: true });
  });
}
