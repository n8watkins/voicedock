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

test('popup: the voice picker groups every engine', async ({ openPopup, seed }) => {
  await seedProfiles(seed);
  const page = await openPopup();
  await page.getByRole('button', { name: /Reading with/ }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a voice' });
  await expect(picker.getByRole('option', { name: /Davefx/ })).toBeVisible();
  await expect(picker.locator('section[aria-label="Favorites"] .vrow')).toHaveCount(2);
  await page.locator('.pk-list').evaluate((el) => { el.scrollTop = 0; });
  await expect(shot(page)).toHaveScreenshot('popup-picker.png');
});

test('popup: Kokoro installed but not running', async ({ engines, openPopup, seed }) => {
  await seedProfiles(seed);
  engines.kokoro.set('stopped');
  const page = await openPopup();
  await expect(page.locator('.reading .sub')).toContainText('Installed but not running');
  await expect(page.locator('.fallback-line')).toHaveText('The Basic voice reads until Kokoro is ready. How to start');
  await expect(page.locator('.dock-cell', { hasText: 'Kokoro' })).toContainText('Not running');
  await expect(shot(page)).toHaveScreenshot('popup-kokoro-stopped.png');
});

test('popup: picking, searching, filtering and starring voices', async ({ openPopup, seed, serviceWorker }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  await seedProfiles(seed);
  const page = await openPopup();
  await page.getByRole('button', { name: /Reading with/ }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a voice' });

  await picker.getByRole('searchbox', { name: 'Search voices' }).fill('cori');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await picker.getByRole('searchbox', { name: 'Search voices' }).fill('');

  await picker.getByRole('combobox', { name: 'Language' }).selectOption('Spanish');
  await expect(picker.locator('section[aria-label="Piper"] .vrow .nm')).toHaveText(['Davefx']);
  await expect(picker.locator('section[aria-label="Kokoro"] .vrow .nm')).toHaveText(['Dora']);
  await picker.getByRole('combobox', { name: 'Language' }).selectOption('');

  await picker.getByRole('button', { name: 'Add George to favorites' }).click();
  await expect(picker.locator('section[aria-label="Favorites"] .vrow')).toHaveCount(3);
  const favorites = await serviceWorker.evaluate(async () => (await chrome.storage.local.get('favoritesByEngine')).favoritesByEngine);
  expect(favorites.kokoro).toEqual(['af_heart', 'bm_george']);

  await picker.locator('section[aria-label="Piper"]').getByRole('option', { name: /Cori/ }).click();
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

test('popup: an engine that never answered reads Not installed', async ({ engines, openPopup, seed }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  await seed({ profiles: PROFILES, activeId: 'articles' });
  engines.kokoro.set('stopped');
  const page = await openPopup();
  await expect(page.locator('.fallback-line')).toContainText('Set it up');
  await page.getByRole('button', { name: /Reading with/ }).click();
  await expect(page.locator('section[aria-label="Kokoro"] .grp-note')).toHaveText('Kokoro is not installed yet.Set up');
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
    await expect(page.locator('.tp-text .hint-warn')).toHaveText('Select text on the page first');

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
