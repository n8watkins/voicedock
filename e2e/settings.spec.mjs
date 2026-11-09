// The settings page: a profile's voice (engine pills, then that engine's
// voices), Voices & Engines and its guided setup panel.
import { expect, onlyOnce, test } from './fixtures.mjs';

const PROFILES = [
  { id: 'a', name: 'Articles', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 },
  { id: 'b', name: 'Long reads', engine: 'piper', voice: 'en_US-ryan-high.onnx', rate: 1, volume: 1 },
];

test('a profile picks its engine with pills, then a voice from that engine', async ({ openOptions, seed, serviceWorker }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  await seed({ profiles: PROFILES, activeId: 'a', favoritesByEngine: { piper: [], kokoro: ['af_heart'] } });
  const page = await openOptions('profiles');
  await page.locator('.profile-card[data-id="a"]').getByRole('button', { name: 'Edit profile' }).click();
  const field = page.locator('.voice-field');
  await expect(field.getByRole('radio', { name: /Kokoro/ })).toHaveAttribute('aria-checked', 'true');
  await expect(field.locator('.vf-button')).toContainText('Heart');

  // The Piper pill switches the engine and opens Piper's voices.
  await field.getByRole('radio', { name: /Piper/ }).click();
  await expect(field.getByRole('searchbox', { name: 'Search voices' })).toHaveAttribute('placeholder', 'Search 5 Piper voices');
  await field.getByRole('searchbox', { name: 'Search voices' }).fill('alan');
  await field.getByRole('button', { name: /^Alan/ }).click();
  await expect(field.locator('.vf-button')).toContainText('Alan');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const { profiles } = await serviceWorker.evaluate(async () => chrome.storage.local.get('profiles'));
  expect(profiles.find((p) => p.id === 'a')).toMatchObject({ engine: 'piper', voice: 'en_GB-alan-medium.onnx' });
});

test('the guided setup panel: steps per OS, opened from a link, and a live check', async ({ engines, openOptions, seed }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  await seed({ profiles: PROFILES, activeId: 'b' });
  engines.kokoro.set('stopped');
  const page = await openOptions('engines:kokoro');
  const drawer = page.getByRole('dialog', { name: 'Set up Kokoro' });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.vd-status').first()).toHaveText('Not installed');
  await drawer.getByRole('tab', { name: 'Windows' }).click();
  await expect(drawer.locator('.setup-steps > li')).toHaveCount(3);
  await expect(drawer.locator('.setup-steps')).toContainText('powershell -ExecutionPolicy Bypass -File setup.ps1');
  await expect(drawer.locator('.setup-steps')).toContainText('irm https://astral.sh/uv/install.ps1 | iex');
  await drawer.getByRole('tab', { name: 'macOS' }).click();
  await expect(drawer.locator('.setup-steps')).toContainText('./setup.sh');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await drawer.locator('.setup-steps > li').nth(1).getByRole('button', { name: /Copy/ }).click();
  await expect(drawer.locator('.setup-steps > li').nth(1).getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('cd voicedock/servers/kokoro\n./setup.sh');

  // The live check: setup finishes, and within a couple of seconds the panel
  // turns green and offers the voice.
  await expect(drawer.locator('.drawer-live')).toContainText('Waiting for Kokoro on this computer');
  engines.kokoro.set('standby');
  await expect(drawer.locator('.drawer-live')).toContainText('Kokoro is set up. It starts when you read.', { timeout: 6000 });
  await drawer.getByRole('button', { name: 'Use this voice' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#engines');
});

test('an engine that is set up but not running offers how to start it', async ({ engines, openOptions }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  engines.kokoro.set('off');
  const page = await openOptions('engines');
  const card = page.locator('.engine-card[data-engine="kokoro"]');
  await expect(card.locator('.vd-status')).toHaveText('Installed but not running');
  await expect(card.locator('.engine-detail')).toHaveText('Memory is low, so Kokoro stays off for now');
  await card.getByRole('button', { name: 'How to start' }).click();
  const drawer = page.getByRole('dialog', { name: 'Start Kokoro' });
  await expect(drawer.locator('.drawer-why')).toHaveText('Memory is low, so Kokoro stays off for now');
  await expect(drawer.locator('.setup-steps > li').first()).toContainText("Start VoiceDock's server");
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Get started offers setup for an engine that is missing', async ({ engines, openOptions }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  engines.piper.set('stopped');
  engines.kokoro.set('stopped');
  const page = await openOptions('welcome');
  await expect(page.locator('.welcome-engines li', { hasText: 'Piper' }).locator('.vd-status')).toHaveText('Not installed');
  await page.getByRole('button', { name: 'Set up Piper' }).click();
  const drawer = page.getByRole('dialog', { name: 'Set up Piper' });
  await expect(drawer.locator('.setup-steps')).toContainText('npm run setup');
  await expect(page.locator('.tab-panel.welcome')).toBeVisible(); // still on Get started
});

test('old links to Voices and Settings open Voices & Engines', async ({ openOptions }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  for (const hash of ['voices', 'settings', 'settings:kokoro']) {
    const page = await openOptions(hash);
    await expect(page.getByRole('heading', { name: 'Voices & Engines' })).toBeVisible();
    await page.close();
  }
});
