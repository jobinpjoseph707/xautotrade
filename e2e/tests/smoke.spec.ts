import { expect, test } from '@playwright/test';
import { API_KEY, SERVER_URL } from '../playwright.config';
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

// With a strategy saved, the Dashboard and Strategies tables must not nest a button inside a button
// (React logs that as a console error), and clicking a row's name must still open that bot.
test('strategy tables have no nested buttons and a row still opens its bot', async ({ page, request }, info) => {
  const phone = info.project.name === 'phone-390';
  const name = `Nesting check ${info.project.name}`;
  const created = await request.post(`${SERVER_URL}/api/strategies`, {
    headers: { 'x-api-key': API_KEY },
    data: {
      name, symbol: 'EURUSD', timeframe: '5m',
      indicators: [{ id: 'rsi', type: 'rsi', params: { period: 14 } }],
      entryLong: { logic: 'AND', conditions: [{ left: { kind: 'indicator', id: 'rsi' }, op: 'lt', right: { kind: 'const', value: 30 } }] },
      entryShort: { logic: 'AND', conditions: [] },
      risk: { fixedLot: 0.01, slMode: 'points', slPoints: 100, tpMode: 'points', tpPoints: 200 },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  const w = watchErrors(page);
  await connect(page);
  const open = async (label: string) => (phone ? page.getByRole('tab', { name: label }).click() : page.getByRole('link', { name: label }).click());
  const nested = () => page.evaluate(() => document.querySelectorAll('button button, [role="button"] [role="button"]').length);

  await open('Dashboard');
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
  expect(await nested(), 'Dashboard').toBe(0);
  await open('Strategies');
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
  expect(await nested(), 'Strategies').toBe(0);
  expect(w.errors.filter((e) => !/favicon|ERR_BLOCKED|Failed to load resource/.test(e))).toEqual([]);

  if (!phone) {
    await open('Dashboard');
    const box = (await page.getByText(name).first().boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // a real click on the name, as a person would
    await expect(page.getByText('Trade history')).toBeVisible({ timeout: 10_000 });
  }
});
