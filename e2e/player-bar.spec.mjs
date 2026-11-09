// The player bar's notes: when an engine can't read, the bar says what
// happened, keeps saying it until dismissed, and offers one fix. Amber while
// the Basic voice reads on; red when nothing can read.
import { expect, test } from './fixtures.mjs';

const KOKORO = [{ id: 'k', name: 'Articles', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];

async function selectParagraph(article) {
  await article.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p1'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

async function readFromPopup(article, openPopup) {
  const popup = await openPopup();
  await article.bringToFront();
  await selectParagraph(article);
  await popup.getByRole('button', { name: 'Read selection' }).click();
  return popup;
}

// Headless Chromium has no system voice. Give chrome.tts one, which "speaks"
// each sentence in 400 ms, so the Basic voice can read on.
async function fakeSystemVoice(serviceWorker) {
  await serviceWorker.evaluate(() => {
    chrome.tts.getVoices = async () => [{ voiceName: 'Test voice', lang: 'en-US', remote: false }];
    chrome.tts.speak = (text, opts) => { setTimeout(() => opts.onEvent?.({ type: 'end' }), 400); };
    chrome.tts.stop = () => {};
  });
}

const clipAround = async (article, locator) => {
  const box = await locator.boundingBox();
  return { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 };
};

test.describe('player bar notes', () => {
  test.use({ pageAccess: true, openShadow: true });

  test('amber: Kokoro is not running, the Basic voice reads, and the note stays with its fix', async ({ context, engines, articleUrl, openPopup, seed, serviceWorker }) => {
    await seed({ profiles: KOKORO, activeId: 'k' });
    engines.kokoro.set('off');
    await fakeSystemVoice(serviceWorker);
    const article = await context.newPage();
    await article.goto(articleUrl);
    await readFromPopup(article, openPopup);

    const note = article.locator('.note');
    await expect(note).toHaveText(/Kokoro is not running\. Reading with the Basic voice\./);
    await expect(note).toHaveClass(/warn/);
    await expect(article.locator('.bar')).toBeVisible();
    await expect(article.locator('.bar .lbl-engine')).toHaveText('Basic voice');
    const stack = article.locator('.stack');
    await expect(article).toHaveScreenshot('note-amber.png', { clip: await clipAround(article, stack), animations: 'disabled' });

    // Still there after the bar updates a few times: notes stay until dismissed.
    await article.waitForTimeout(1200);
    await expect(note).toBeVisible();

    const opened = context.waitForEvent('page');
    await note.getByRole('button', { name: 'How to start' }).click();
    expect((await opened).url()).toMatch(/options\.html#engines:kokoro$/);
    await article.bringToFront();
    await note.getByRole('button', { name: 'Dismiss' }).click();
    await expect(article.locator('.note')).toHaveCount(0);
  });

  test('red: no system voice and no engine, so nothing can read', async ({ context, engines, articleUrl, openPopup, seed }) => {
    await seed({ profiles: KOKORO, activeId: 'k' });
    engines.piper.set('stopped'); // the whole hub is down
    const article = await context.newPage();
    await article.goto(articleUrl);
    await readFromPopup(article, openPopup);

    const note = article.locator('.note');
    await expect(note).toHaveText(/Nothing to read with\. This computer has no built-in voice, and no engine is ready\./);
    await expect(note).toHaveClass(/err/);
    await expect(note).toHaveAttribute('role', 'alert');
    await expect(article.locator('.bar')).toHaveCount(0);
    await expect(note.getByRole('button', { name: 'Set up Piper' })).toBeVisible();
    await expect(article).toHaveScreenshot('note-red.png', { clip: await clipAround(article, article.locator('.stack')), animations: 'disabled' });
  });

  test('a cold Kokoro says how long it takes in the bar, then reads', async ({ context, engines, articleUrl, openPopup, seed }) => {
    await seed({ profiles: KOKORO, activeId: 'k' });
    engines.kokoro.set('standby');
    const article = await context.newPage();
    await article.goto(articleUrl);
    await readFromPopup(article, openPopup);
    await expect(article.locator('.bar .lbl-text')).toHaveText('Starting Kokoro, about 3 s');
    await expect(article.locator('.bar .lbl-text')).toHaveText(/Reading sentence \d of 3/, { timeout: 8000 });
    await expect.poll(() => engines.kokoro.state.ttsRequests.length).toBeGreaterThan(0);
    await expect(article.locator('.note')).toHaveCount(0);
  });
});
