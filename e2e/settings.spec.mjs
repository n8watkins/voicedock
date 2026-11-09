// The settings page: a profile's voice (engine pills, then that engine's
// voices) and the setup steps per engine and OS.
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

test('setup steps per engine and OS, opened from a link', async ({ engines, openOptions }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  engines.kokoro.set('stopped');
  const page = await openOptions('settings:kokoro');
  const guide = page.locator('.setup-guide');
  await expect(guide.getByRole('radio', { name: /Kokoro/ })).toHaveAttribute('aria-checked', 'true');
  await guide.getByRole('tab', { name: 'Windows' }).click();
  await expect(guide.locator('.setup-steps > li')).toHaveCount(3);
  await expect(guide.locator('.setup-steps')).toContainText('powershell -ExecutionPolicy Bypass -File setup.ps1');
  await expect(guide.locator('.setup-steps')).toContainText('irm https://astral.sh/uv/install.ps1 | iex');
  await guide.getByRole('tab', { name: 'macOS' }).click();
  await expect(guide.locator('.setup-steps')).toContainText('./setup.sh');
  await expect(guide.locator('.setup-states')).toContainText('Start Piper first');

  // Piper's steps, and a copy button per step.
  await guide.getByRole('radio', { name: /Piper/ }).click();
  await guide.getByRole('tab', { name: 'Windows' }).click();
  await expect(guide.locator('.setup-steps')).toContainText('winget install -e --id OpenJS.NodeJS.LTS');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await guide.locator('.setup-steps > li').nth(2).getByRole('button', { name: /Copy/ }).click();
  await expect(guide.locator('.setup-steps > li').nth(2).getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm run setup');
});

test('Get started offers the setup steps for an engine that is missing', async ({ engines, openOptions }, testInfo) => {
  test.skip(onlyOnce(testInfo));
  engines.piper.set('stopped');
  engines.kokoro.set('stopped');
  const page = await openOptions('welcome');
  await expect(page.locator('.setup-guide')).toBeVisible();
  await expect(page.locator('.setup-guide').getByRole('radio', { name: /Piper/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.welcome-engines li', { hasText: 'Piper' }).locator('.vd-status')).toHaveText('Not installed');
});
