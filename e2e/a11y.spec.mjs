// Accessibility: axe-core's WCAG 2.1 A and AA rules (colour contrast among
// them: 4.5:1 for text, 3:1 for large text) on every surface, in light and
// dark: the popup (with the picker and an engine down), the player bar, and
// every settings tab (with a profile form and the voice list open).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.mjs';

const PROFILES = [
  { id: 'articles', name: 'Articles', engine: 'kokoro', voice: 'af_heart', rate: 1.2, volume: 1 },
  { id: 'long', name: 'Long reads', engine: 'piper', voice: 'en_US-ryan-high.onnx', rate: 1, volume: 1 },
];
const SEED = {
  profiles: PROFILES,
  activeId: 'articles',
  engineSeen: { piper: '2026-11-01T09:00:00.000Z', kokoro: '2026-11-01T09:00:00.000Z' },
  favoritesByEngine: { piper: ['en_US-ryan-high.onnx'], kokoro: ['af_heart'] },
  deletedVoices: [{ filename: 'en_US-lessac-medium.onnx', displayName: 'Lessac · Medium', deletedAt: '11/1/2026' }],
};

// Screenshots cover 2x; contrast does not change with pixel ratio.
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name.endsWith('-2x'), 'colour contrast is the same at 2x');
});

async function expectNoViolations(page, label, include) {
  // Measure the settled page, not a sheet halfway through its entrance.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  const report = violations.map((v) => `${v.id}: ${v.help}\n${v.nodes.slice(0, 6).map((n) => `  ${n.target.join(' ')}  ${n.failureSummary?.split('\n').slice(1, 2).join('') || ''}`).join('\n')}`);
  expect(report, `${label}\n${report.join('\n')}`).toEqual([]);
}

test('popup: no accessibility violations', async ({ engines, openPopup, seed }) => {
  await seed(SEED);
  let page = await openPopup();
  await expect(page.locator('.dock .vd-status.ready')).toHaveCount(3);
  await expectNoViolations(page, 'popup');
  await page.getByRole('button', { name: /Reading with/ }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a voice' })).toBeVisible();
  await expectNoViolations(page, 'popup picker');
  await page.close();

  engines.kokoro.set('stopped');
  page = await openPopup();
  await expect(page.locator('.fallback-line')).toBeVisible();
  await expectNoViolations(page, 'popup, Kokoro not running');
  await page.getByRole('button', { name: /Reading with/ }).click();
  await expectNoViolations(page, 'popup picker, Kokoro not running');
});

for (const tab of ['welcome', 'profiles', 'engines', 'shortcuts', 'about', 'credits']) {
  test(`settings page ${tab}: no accessibility violations`, async ({ engines, openOptions, seed }) => {
    await seed(SEED);
    if (tab === 'welcome') engines.kokoro.set('stopped');
    const page = await openOptions(tab);
    await expect(page.locator('.side-engines .vd-status').first()).not.toHaveText('Checking');
    if (tab === 'profiles') {
      await page.locator('.profile-card').first().getByRole('button', { name: 'Edit profile' }).click();
      await page.locator('.vf-button').click();
      await expect(page.locator('.vf-pop')).toBeVisible();
    }
    if (tab === 'engines') {
      await page.locator('.voices-engines').getByRole('radio', { name: /Piper/ }).click();
      await page.locator('.deleted-summary').click();
    }
    await expectNoViolations(page, `settings ${tab}`);
  });
}

test('the guided setup panel: no accessibility violations', async ({ engines, openOptions, seed }) => {
  await seed(SEED);
  for (const mode of ['stopped', 'off', 'standby']) {
    engines.kokoro.set(mode);
    const page = await openOptions('engines:kokoro');
    await expect(page.getByRole('dialog').locator('.drawer-live')).toBeVisible();
    await expectNoViolations(page, `setup panel, Kokoro ${mode}`);
    await page.close();
  }
});

test.describe('player bar', () => {
  test.use({ pageAccess: true, openShadow: true });

  test('player bar: no accessibility violations', async ({ context, articleUrl, openPopup, seed }) => {
    await seed({ ...SEED, activeId: 'long' });
    const article = await context.newPage();
    await article.goto(articleUrl);
    const page = await openPopup();
    await article.bringToFront();
    await article.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('p1'));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    await page.getByRole('button', { name: 'Read selection' }).click();
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.tp-text b')).toHaveText('Paused');
    await article.bringToFront();
    const host = article.locator('body > div').last();
    await expect(host).toBeVisible();
    await expectNoViolations(article, 'player bar', 'body > div:last-child');
    await expectNoViolations(page, 'popup while reading');
  });
});
