// The redesigned popup: profile pills, "Reading with", the voice picker
// (search, language filter, favorites, previews), transport controls and the
// dock strip of engine statuses.
import { expect, onlyOnce, test } from './fixtures.mjs';

const PROFILES = [
  { id: 'articles', name: 'Articles', engine: 'kokoro', voice: 'af_heart', rate: 1.2, volume: 1 },
  { id: 'long', name: 'Long reads', engine: 'piper', voice: 'en_US-ryan-high.onnx', rate: 1, volume: 1 },
  { id: 'spanish', name: 'Spanish', engine: 'kokoro', voice: 'ef_dora', rate: 1, volume: 1 },
];
const SEEN = { piper: '2026-11-01T09:00:00.000Z', kokoro: '2026-11-01T09:00:00.000Z' };

async function seedProfiles(seed, extra = {}) {
  await seed({ profiles: PROFILES, activeId: 'articles', engineSeen: SEEN, favoritesByEngine: { piper: ['en_US-ryan-high.onnx'], kokoro: ['af_heart'] }, ...extra });
}

const shot = (page) => page.locator('.popup');

test('popup: reading with Heart on Kokoro', async ({ openPopup, seed }) => {
  await seedProfiles(seed);
  const page = await openPopup();
  await expect(page.locator('.reading .name')).toHaveText('Heart');
  await expect(page.locator('.reading .sub')).toHaveText('Kokoro · US English · female');
  await expect(page.locator('.dock .vd-status.ready')).toHaveCount(3);
  await expect(shot(page)).toHaveScreenshot('popup-default.png');
});

test('popup: the voice picker shows engine pills, then that engine\'s voices', async ({ openPopup, seed }) => {
  await seedProfiles(seed);
  const page = await openPopup();
  await page.getByRole('button', { name: /Reading with/ }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a voice' });
  // Opens on the profile's engine (Kokoro), with its favorite first.
  await expect(picker.getByRole('radio', { name: /Kokoro/ })).toHaveAttribute('aria-checked', 'true');
  await expect(picker.locator('section[aria-label="Favorites"] .vrow .nm')).toHaveText(['Heart']);
  await expect(picker.getByRole('button', { name: /^Davefx/ })).toHaveCount(0);
  await expect(picker.getByRole('searchbox', { name: 'Search voices' })).toHaveAttribute('placeholder', 'Search 6 Kokoro voices');
  // The search box takes focus on open. Whether the headless window itself
  // has focus varies, and with it the focus ring, so the shot is taken blurred.
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Search voices');
  await picker.getByRole('searchbox', { name: 'Search voices' }).evaluate((el) => el.blur());
  await page.locator('.pk-list').evaluate((el) => { el.scrollTop = 0; });
  await expect(shot(page)).toHaveScreenshot('popup-picker.png');
});

test('popup: Kokoro installed but not running', async ({ engines, openPopup, seed }) => {
  await seedProfiles(seed);
  engines.kokoro.set('stopped');
  const page = await openPopup();
  await expect(page.locator('.reading .sub')).toContainText('Installed but not running');
  await expect(page.locator('.fallback-line')).toHaveText('Basic voice reads until Kokoro runs. How to start');
  await expect(page.locator('.dock-cell', { hasText: 'Kokoro' })).toContainText('Not running');
  await expect(shot(page)).toHaveScreenshot('popup-kokoro-stopped.png');
});

test('popup: a Kokoro that starts on demand is on standby, and opening the popup starts it', async ({ engines, openPopup, seed }) => {
  await seedProfiles(seed);
  engines.kokoro.set('stopped');
  engines.hub.onDemand = true;
  const page = await openPopup();
  await expect(page.locator('.dock-cell', { hasText: 'Kokoro' })).toContainText(/Standby|Ready/);
  await expect(page.locator('.fallback-line')).toHaveCount(0);
  // The popup on a Kokoro profile warms Kokoro up.
  await expect.poll(() => engines.hub.starts).toBe(1);
  await expect(page.locator('.dock-cell', { hasText: 'Kokoro' })).toContainText('Ready', { timeout: 10_000 });
});

test('popup: picking, searching, filtering and starring voices', async ({ openPopup, seed, serviceWorker }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  await seedProfiles(seed);
  const page = await openPopup();
  await page.getByRole('button', { name: /Reading with/ }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a voice' });

  // Kokoro first: search, language, a new favorite.
  await picker.getByRole('searchbox', { name: 'Search voices' }).fill('geo');
  await expect(picker.locator('.vrow .nm')).toHaveText(['George']);
  await picker.getByRole('searchbox', { name: 'Search voices' }).fill('');
  await picker.getByRole('combobox', { name: 'Language' }).selectOption('Spanish');
  await expect(picker.locator('.vrow .nm')).toHaveText(['Dora']);
  await picker.getByRole('combobox', { name: 'Language' }).selectOption('');
  await picker.getByRole('button', { name: 'Add George to favorites' }).click();
  await expect(picker.locator('section[aria-label="Favorites"] .vrow')).toHaveCount(2);
  const favorites = await serviceWorker.evaluate(async () => (await chrome.storage.local.get('favoritesByEngine')).favoritesByEngine);
  expect(favorites.kokoro).toEqual(['af_heart', 'bm_george']);

  // Then the Piper pill lists Piper's voices.
  await picker.getByRole('radio', { name: /Piper/ }).click();
  await expect(picker.getByRole('searchbox', { name: 'Search voices' })).toHaveAttribute('placeholder', 'Search 5 Piper voices');
  await picker.getByRole('searchbox', { name: 'Search voices' }).fill('cori');
  await expect(picker.locator('.vrow .nm')).toHaveText(['Cori']);
  await picker.getByRole('button', { name: /^Cori/ }).click();
  await expect(picker).toBeHidden();
  await expect(page.locator('.reading .name')).toHaveText('Cori');
  await expect(page.locator('.reading .sub')).toHaveText('Piper · UK English');
  const { profiles } = await serviceWorker.evaluate(async () => chrome.storage.local.get('profiles'));
  expect(profiles.find((p) => p.id === 'articles')).toMatchObject({ engine: 'piper', voice: 'en_GB-cori-high.onnx' });
});

test('popup: a preview plays that voice on its engine', async ({ engines, openPopup, seed }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  await seedProfiles(seed);
  const page = await openPopup();
  await page.getByRole('button', { name: /Reading with/ }).click();
  await page.getByRole('radio', { name: /Piper/ }).click();
  await page.getByRole('button', { name: 'Play a sample of Alan' }).click();
  await expect.poll(() => engines.piper.state.ttsRequests.map((r) => r.voice)).toContain('en_GB-alan-medium.onnx');
  await expect(page.getByRole('button', { name: 'Stop the Alan sample' })).toBeVisible();
});

test('popup: profile pills switch what reads, and a new profile copies the current one', async ({ openPopup, seed, serviceWorker }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  await seedProfiles(seed);
  const page = await openPopup();
  await page.getByRole('button', { name: 'Long reads' }).click();
  await expect(page.getByRole('button', { name: 'Long reads' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.reading .name')).toHaveText('Ryan');
  await page.getByRole('button', { name: 'Faster' }).click();
  await expect(page.locator('.stepper output')).toHaveText('1.1×');
  await page.getByRole('button', { name: 'New profile' }).click();
  await page.getByRole('textbox', { name: 'New profile name' }).fill('Night');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('button', { name: 'Night' })).toHaveAttribute('aria-pressed', 'true');
  const { profiles } = await serviceWorker.evaluate(async () => chrome.storage.local.get('profiles'));
  expect(profiles.find((p) => p.name === 'Night')).toMatchObject({ engine: 'piper', voice: 'en_US-ryan-high.onnx', rate: 1.1 });
});

test('popup: an engine that never answered reads Not installed', async ({ context, engines, openPopup, seed }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  await seed({ profiles: PROFILES, activeId: 'articles' });
  engines.kokoro.set('stopped');
  const page = await openPopup();
  await expect(page.locator('.fallback-line')).toContainText('Set it up');
  await page.getByRole('button', { name: /Reading with/ }).click();
  // The Kokoro pill shows its state, and the list offers setup instead of voices.
  const picker = page.getByRole('dialog', { name: 'Choose a voice' });
  await expect(picker.getByRole('radio', { name: /Kokoro/ })).toContainText('Not installed');
  await expect(picker.locator('.setup-note')).toContainText("Kokoro isn't set up on this computer yet.");
  const opened = context.waitForEvent('page');
  await picker.getByRole('button', { name: 'Set up Kokoro' }).click();
  expect((await opened).url()).toMatch(/options\.html#settings:kokoro$/);
});

test.describe('reading from a page', () => {
  test.use({ pageAccess: true });

  test('popup: read selection, by sentence, with pause, skip and stop', async ({ context, engines, articleUrl, openPopup, seed }) => {
    await seedProfiles(seed, { activeId: 'long' });
    const article = await context.newPage();
    await article.goto(articleUrl);
    const page = await openPopup();
    await article.bringToFront();

    await page.getByRole('button', { name: 'Read selection' }).click();
    await expect(page.locator('.tp-text .hint-warn')).toHaveText('Select text first');

    await article.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('p1'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.getByRole('button', { name: 'Read selection' }).click();
    await expect(page.locator('.tp-text > span')).toHaveText(/Sentence 1 of 3/);
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.tp-text b')).toHaveText('Paused');
    await expect(page.locator('.play-big')).not.toHaveClass(/live/);
    await page.getByRole('button', { name: 'Next sentence' }).click();
    await expect(page.locator('.tp-text > span')).toHaveText('Sentence 2 of 3');
    await expect.poll(() => engines.piper.state.ttsRequests.map((r) => r.text)).toContain('Silent reading was a skill that monks remarked on as unusual.');
    await expect(shot(page)).toHaveScreenshot('popup-reading.png');

    // The player bar on the page shows the same sentence.
    await article.bringToFront();
    const host = article.locator('body > div').last();
    const box = await host.boundingBox();
    await expect(article).toHaveScreenshot('player-bar-paused.png', {
      clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 },
    });

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('button', { name: 'Read selection' })).toBeVisible();
  });
});
