import { expect, test } from '@playwright/test';
import { connect, TAB_MARKER, TABS, watchErrors } from './helpers';

// T-0.7: app loads, every tab opens with keys 1-8, no console errors.
test('every tab opens with keys 1 to 8 and nothing logs an error', async ({ page }) => {
  const w = watchErrors(page);
  await connect(page);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < TABS.length; i++) {
    await page.keyboard.press(String(i + 1));
    await expect(page.getByText(TAB_MARKER[TABS[i]]).first(), `tab ${i + 1} ${TABS[i]}`).toBeVisible({ timeout: 10_000 });
  }
  expect(w.errors.filter((e) => !/favicon|ERR_BLOCKED|Failed to load resource/.test(e))).toEqual([]);
});

test('levels and activity are no longer tabs', async ({ page }) => {
  await connect(page);
  await expect(page.getByLabel('Chart lines')).toHaveCount(0);
  await expect(page.getByLabel('Activity', { exact: true })).toHaveCount(0);
});
