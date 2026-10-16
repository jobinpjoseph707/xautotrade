import { expect, test } from '@playwright/test';
import { API_KEY, SERVER_URL } from '../playwright.config';
import { connect } from './helpers';

async function openInbox(page: import('@playwright/test').Page, phone: boolean) {
  if (phone) await page.getByRole('tab', { name: 'Inbox' }).click();
  else await page.getByRole('link', { name: 'Inbox' }).click();
}

// I-9
test('an empty Inbox says nothing needs you', async ({ page }, info) => {
  await connect(page);
  await openInbox(page, info.project.name === 'phone-390');
  await expect(page.getByText('Nothing needs you')).toBeVisible();
  await expect(page.getByText('You can close the app.')).toBeVisible();
});

// I-10
test('a card appears with a count on the tab, and Dismiss removes it', async ({ page, request }, info) => {
  const phone = info.project.name === 'phone-390';
  const title = `Seeded ${info.project.name}`;
  const seeded = await request.post(`${SERVER_URL}/api/inbox/_seed`, { headers: { 'x-api-key': API_KEY }, data: { title } });
  expect(seeded.ok()).toBeTruthy();
  await connect(page);
  await openInbox(page, phone);
  await expect(page.getByText(title)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel(/\d+ open/).first()).toBeVisible();
  await expect(page.getByText('What do I do?').first()).toBeVisible();
  await page.getByText('Dismiss', { exact: true }).first().click();
  await expect(page.getByText(title)).toHaveCount(0);
});
