import { expect, type Page } from '@playwright/test';
import { API_KEY, SERVER_URL } from '../playwright.config';

/** Collects console errors and uncaught page errors; call `.errors` at the end of a test. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return { errors };
}

/** Connects the app to the paper-mode test server and waits for the shell. */
export async function connect(page: Page) {
  await page.goto('/');
  await page.getByPlaceholder('http://192.168.1.2:4000').fill(SERVER_URL);
  await page.getByPlaceholder('paste the key printed by the server').fill(API_KEY);
  await page.getByText('Connect', { exact: true }).last().click();
  await expect(page.getByText('Dashboard').first()).toBeVisible({ timeout: 30_000 });
}

export const TABS = ['Dashboard', 'Inbox', 'Strategies', 'Testboard', 'Journal', 'Agents', 'Settings', 'Help'] as const;

/** One piece of text that is only visible on each tab's own screen. */
export const TAB_MARKER: Record<(typeof TABS)[number], string | RegExp> = {
  Dashboard: /XAutoTrade Paper/,
  Inbox: 'Everything that needs you will appear here',
  Strategies: /\d+ strateg(y|ies)/,
  Testboard: 'Which stage each strategy has reached',
  Journal: 'Trade journal',
  Agents: /AI agents propose changes/,
  Settings: 'Server connection, account and session',
  Help: 'What to do each day, and when something goes wrong',
};
