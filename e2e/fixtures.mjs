// Playwright fixtures: VoiceDock loaded unpacked in Chromium with a fresh
// profile per test, the fake engines on 7477/7478, and helpers to open the
// popup and settings pages and to seed chrome.storage.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect } from '@playwright/test';
import { startFakeEngines } from './fake-engines.mjs';

export const EXTENSION_DIR = resolve(import.meta.dirname, '..', 'extension');

// A test can't click the toolbar button, which is what grants VoiceDock
// activeTab on a real page. With pageAccess, the test loads a copy of the
// extension whose manifest also allows http://127.0.0.1 pages, so the popup's
// Read selection and the player bar work on the test article.
function extensionCopyWithPageAccess() {
  const dir = mkdtempSync(join(tmpdir(), 'voicedock-ext-'));
  cpSync(EXTENSION_DIR, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

export const ARTICLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reading aloud</title>
<style>body{margin:0;background:#fbfaf7;color:#23212b;font:17px/1.7 Georgia,serif}article{max-width:640px;margin:40px auto;padding:0 24px}h1{font-size:28px;line-height:1.2}</style></head>
<body><article><h1>The quiet comeback of reading aloud</h1>
<p id="p1">For most of history, reading was something people did out loud. Silent reading was a skill that monks remarked on as unusual. Now our screens are bringing the older habit back.</p>
<p id="p2">A good voice changes how long you can stay with a text. It keeps pace when your eyes are tired, and it lets you look away without losing your place.</p>
</article></body></html>`;

export const test = base.extend({
  pageAccess: [false, { option: true }],

  // A local page to read from, served on a free port.
  articleUrl: [async ({}, use) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE_HTML);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    await use(`http://127.0.0.1:${server.address().port}/article.html`);
    await new Promise((r) => server.close(r));
  }, { scope: 'worker' }],

  // One pair of fake engines per worker, reset to "running" before each test.
  engines: [async ({}, use) => {
    const engines = await startFakeEngines();
    await use(engines);
    await engines.close();
  }, { scope: 'worker' }],

  context: async ({ engines, colorScheme, deviceScaleFactor, pageAccess }, use) => {
    engines.reset();
    const extensionDir = pageAccess ? extensionCopyWithPageAccess() : EXTENSION_DIR;
    const profile = mkdtempSync(join(tmpdir(), 'voicedock-e2e-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      colorScheme,
      deviceScaleFactor,
      viewport: { width: 1100, height: 900 },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
    if (extensionDir !== EXTENSION_DIR) rmSync(extensionDir, { recursive: true, force: true });
  },

  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  // Writes chrome.storage.local (and waits for the install-time migration, so
  // it can't overwrite what the test seeds).
  seed: async ({ serviceWorker, context, extensionId }, use) => {
    await waitForWelcomeTab(context, extensionId);
    // The install handler seeds a default profile and builds the menus; wait
    // until it has, so it can't overwrite what the test writes next.
    await expect.poll(() => serviceWorker.evaluate(async () => {
      const { profiles, settingsVersion } = await chrome.storage.local.get(['profiles', 'settingsVersion']);
      return Array.isArray(profiles) && profiles.length > 0 && Boolean(settingsVersion);
    }), { timeout: 10_000 }).toBe(true);
    await use(async (data) => {
      await serviceWorker.evaluate(async (items) => {
        await chrome.storage.local.set(items);
      }, data);
    });
  },

  openPopup: async ({ context, extensionId }, use) => {
    await use(async ({ width = 360, height = 600 } = {}) => {
      // The popup page is 360 px wide; a taller viewport leaves room for the
      // picker.
      await waitForWelcomeTab(context, extensionId);
      const page = await context.newPage();
      await page.setViewportSize({ width, height });
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await page.evaluate(() => document.fonts.ready);
      return page;
    });
  },

  openOptions: async ({ context, extensionId }, use) => {
    await use(async (hash = 'profiles', { width = 1100, height = 900 } = {}) => {
      await waitForWelcomeTab(context, extensionId);
      const page = await context.newPage();
      await page.setViewportSize({ width, height });
      await page.goto(`chrome-extension://${extensionId}/options.html#${hash}`);
      await page.evaluate(() => document.fonts.ready);
      return page;
    });
  },
});

// A fresh install opens Get started in a tab; wait for it and close it so it
// never races the test's own pages.
const welcomeClosed = new WeakSet();
async function waitForWelcomeTab(context, extensionId) {
  if (welcomeClosed.has(context)) return;
  const isWelcome = (p) => p.url().startsWith(`chrome-extension://${extensionId}/options.html`);
  let page = context.pages().find(isWelcome);
  if (!page) page = await context.waitForEvent('page', { predicate: isWelcome, timeout: 5000 }).catch(() => null);
  if (page) await page.close();
  welcomeClosed.add(context);
}

// The screenshot baselines exist per theme and pixel ratio; behaviour tests
// run once, in the light 1x project.
export function onlyOnce(testInfo) {
  return testInfo.project.name !== 'light-1x';
}

export { expect };
