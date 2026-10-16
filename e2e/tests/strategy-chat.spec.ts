import { expect, test } from '@playwright/test';
import { API_KEY, SERVER_URL } from '../playwright.config';
import { connect } from './helpers';

test('each strategy row opens its own chat with the four buttons', async ({ page, request }, info) => {
  const name = `Chat target ${info.project.name}`;
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

  await connect(page);
  if (info.project.name === 'phone-390') await page.getByRole('tab', { name: 'Strategies' }).click();
  else await page.getByRole('link', { name: 'Strategies' }).click();

  await page.getByLabel(`Chat about ${name}`).first().click();
  await expect(page.getByText(`Chat: ${name}`)).toBeVisible();
  for (const label of ['Tune', 'Diagnose', 'Tighten risk', 'Critique']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  await expect(page.getByText('Nothing changes until you tap Approve.')).toBeVisible();
});
