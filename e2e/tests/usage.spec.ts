import { expect, test } from '@playwright/test';
import { connect } from './helpers';

test('Settings shows Claude use and the daily limit on automatic calls', async ({ page }, info) => {
  await connect(page);
  if (info.project.name === 'phone-390') await page.getByRole('tab', { name: 'Settings' }).click();
  else await page.getByRole('link', { name: 'Settings' }).click();
  const panel = page.getByLabel('Claude use');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText(/of 40 automatic calls used today/)).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText(/Your own chat messages are never limited/)).toBeVisible();
  await panel.getByText('Today', { exact: true }).click();
  await expect(panel.getByText(/of 40 automatic calls used today/)).toBeVisible();
});
