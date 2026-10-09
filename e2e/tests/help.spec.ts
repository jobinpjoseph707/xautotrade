import { expect, test } from '@playwright/test';
import { API_KEY, SERVER_URL } from '../playwright.config';
import { connect } from './helpers';

async function openTab(page: import('@playwright/test').Page, phone: boolean, name: string) {
  if (phone) await page.getByRole('tab', { name }).click();
  else await page.getByRole('link', { name }).click();
}

// HP-6
test('Help opens with the daily routine, before any tab description', async ({ page }, info) => {
  await connect(page);
  await openTab(page, info.project.name === 'phone-390', 'Help');
  const routine = page.getByText('Every day, about 10 minutes');
  await expect(routine).toBeVisible();
  const perTab = page.getByText('More detail, tab by tab');
  const [r, t] = [await routine.boundingBox(), await perTab.boundingBox()];
  expect(r!.y).toBeLessThan(t!.y);
  await expect(page.getByText('When you see this, do this')).toBeVisible();
  await expect(page.getByText('One line per tab')).toBeVisible();
  // The removed tabs are no longer described.
  await expect(page.getByText('Chart lines')).toHaveCount(0);
  await expect(page.getByText('Activity', { exact: true })).toHaveCount(0);
});

// HP-7
test('"What do I do?" on an inbox card opens Help at that entry', async ({ page, request }, info) => {
  const phone = info.project.name === 'phone-390';
  const title = `Help link ${info.project.name}`;
  const seeded = await request.post(`${SERVER_URL}/api/inbox/_seed`, { headers: { 'x-api-key': API_KEY }, data: { title } });
  expect(seeded.ok()).toBeTruthy();
  await connect(page);
  await openTab(page, phone, 'Inbox');
  await expect(page.getByText(title)).toBeVisible({ timeout: 20_000 });
  await page.getByText('What do I do?').first().click();
  // The seeded card is a losing streak, so its own entry is shown first.
  await expect(page.getByText('From your Inbox card')).toBeVisible();
  await expect(page.getByText('Losing streak: five losing trades in a row on one strategy').first()).toBeVisible();
  await page.getByText('Back to Inbox', { exact: true }).click();
  await expect(page.getByText('Everything that needs you will appear here')).toBeVisible();
  await page.getByText('Dismiss', { exact: true }).first().click();
  await expect(page.getByText(title)).toHaveCount(0);
});
