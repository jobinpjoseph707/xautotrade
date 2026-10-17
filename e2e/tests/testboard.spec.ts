import { expect, test, type Page } from '@playwright/test';
import { API_KEY, SERVER_URL } from '../playwright.config';
import { connect } from './helpers';

async function openTestboard(page: Page, phone: boolean) {
  if (phone) await page.getByRole('tab', { name: 'Testboard' }).click();
  else await page.getByRole('link', { name: 'Testboard' }).click();
  await expect(page.getByText('Which stage each strategy has reached')).toBeVisible();
}

async function seedDemoBot(request: import('@playwright/test').APIRequestContext, name: string, trades: number) {
  const r = await request.post(`${SERVER_URL}/api/testboard/_seed`, { headers: { 'x-api-key': API_KEY }, data: { name, trades } });
  expect(r.ok()).toBeTruthy();
}

// G-14
test('a strategy with 40 demo trades shows "40 / 100" and "Not enough trades yet"', async ({ page, request }, info) => {
  const name = `E2E 40 trades ${info.project.name}`;
  await seedDemoBot(request, name, 40);
  await connect(page);
  await openTestboard(page, info.project.name === 'phone-390');
  await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('40 / 100 trades').first()).toBeVisible();
  await expect(page.getByText('Not enough trades yet').first()).toBeVisible();
  await expect(page.getByLabel('Demo stage, current').first()).toBeVisible();
});

// G-15
test('the live stage shows a padlock and cannot be tapped', async ({ page, request }, info) => {
  await seedDemoBot(request, `E2E live lock ${info.project.name}`, 5);
  await connect(page);
  await openTestboard(page, info.project.name === 'phone-390');
  const live = page.getByLabel('Live stage, locked').first();
  await expect(live).toBeVisible({ timeout: 20_000 });
  await expect(live).toContainText('🔒');
  await expect(live).toHaveAttribute('aria-disabled', 'true');
  // Tapping it does nothing: still on the Testboard, still on the demo stage, no dialog.
  await live.click({ force: true });
  await expect(page.getByText('Which stage each strategy has reached')).toBeVisible();
  await expect(page.getByLabel('Demo stage, current').first()).toBeVisible();
  // And the server agrees: there is no way to run a test for the live stage, or to move there.
  const rows = (await (await request.get(`${SERVER_URL}/api/testboard`, { headers: { 'x-api-key': API_KEY } })).json()) as { data: { stage: string }[] };
  expect(rows.data.every((r) => r.stage !== 'live')).toBe(true);
});
