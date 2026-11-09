// Playwright fixtures: VoiceDock loaded unpacked in Chromium with a fresh
// profile per test, the fake engines on 7477/7478, and helpers to open the
// popup and settings pages and to seed chrome.storage.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect } from '@playwright/test';
import { startFakeEngines } from './fake-engines.mjs';

export const EXTENSION_DIR = resolve(import.meta.dirname, '..', 'extension');

export const test = base.extend({
  // One pair of fake engines per worker, reset to "running" before each test.
  engines: [async ({}, use) => {
    const engines = await startFakeEngines();
    await use(engines);
    await engines.close();
  }, { scope: 'worker' }],

  context: async ({ engines, colorScheme, deviceScaleFactor }, use) => {
    engines.reset();
    const profile = mkdtempSync(join(tmpdir(), 'voicedock-e2e-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      colorScheme,
      deviceScaleFactor,
      viewport: { width: 1100, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
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
    await use(async (data) => {
      await serviceWorker.evaluate(async (items) => {
        await chrome.storage.local.set(items);
      }, data);
    });
  },

  openPopup: async ({ context, extensionId }, use) => {
    await use(async ({ width = 360, height = 600 } = {}) => {
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
