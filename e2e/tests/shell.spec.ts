import { expect, test } from '@playwright/test';
import { connect } from './helpers';

test('the desktop sidebar collapses to a rail and expands again', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'the sidebar only exists on wide screens');
  await connect(page);
  await page.getByLabel('Collapse sidebar').click();
  await expect(page.getByLabel('Expand sidebar')).toBeVisible();
  await page.getByLabel('Expand sidebar').click();
  await expect(page.getByLabel('Collapse sidebar')).toBeVisible();
});

test('the phone shows a bottom tab bar with all 8 tabs', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone-390', 'tab bar is the phone layout');
  await connect(page);
  await expect(page.getByRole('tab')).toHaveCount(8);
});
