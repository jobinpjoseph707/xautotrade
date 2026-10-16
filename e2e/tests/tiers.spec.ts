import { expect, test } from '@playwright/test';
import { connect } from './helpers';

test('the Dashboard shows five risk tiers with their caps', async ({ page }, info) => {
  await connect(page);
  if (info.project.name === 'phone-390') await page.getByRole('tab', { name: 'Dashboard' }).click();
  else await page.getByRole('link', { name: 'Dashboard' }).click();
  const tiles = page.getByLabel('Risk tiers');
  await expect(tiles).toBeVisible({ timeout: 20_000 });
  for (const name of ['Safe', 'Cautious', 'Moderate', 'Active', 'Aggressive']) await expect(tiles.getByText(new RegExp(`· ${name}$`))).toBeVisible();
  await expect(tiles.getByText(/cap 0\.60%/)).toBeVisible();
});
