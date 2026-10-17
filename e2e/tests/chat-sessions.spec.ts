import { expect, test } from '@playwright/test';
import { API_KEY, SERVER_URL } from '../playwright.config';
import { connect } from './helpers';

async function openAgents(page: import('@playwright/test').Page, phone: boolean) {
  if (phone) await page.getByRole('tab', { name: 'Agents' }).click();
  else await page.getByRole('link', { name: 'Agents' }).click();
}

const seed = (request: import('@playwright/test').APIRequestContext, data: object) =>
  request.post(`${SERVER_URL}/api/chat/sessions/_seed`, { headers: { 'x-api-key': API_KEY }, data });

// CS-E1: a saved chat is listed under Previous chats, can be opened, and New chat clears the screen without deleting it.
test('Agents: Previous chats lists saved chats, opens one, and New chat starts fresh', async ({ page, request }, info) => {
  const tag = info.project.name;
  const ask = `Why is ${tag} quiet today`;
  const r = await seed(request, { messages: [{ role: 'user', text: ask }, { role: 'agent', text: `Because ${tag} saw no setups.` }] });
  expect(r.ok(), await r.text()).toBeTruthy();

  await connect(page);
  await openAgents(page, tag === 'phone-390');

  await page.getByRole('button', { name: 'Previous chats' }).click();
  await expect(page.getByText('Previous chats').first()).toBeVisible();
  await expect(page.getByText(/^TODAY$/)).toBeVisible();
  await page.getByRole('button', { name: `Open chat ${ask}` }).click();
  await expect(page.getByRole('button', { name: /^Open chat/ })).toHaveCount(0); // the list has closed
  await expect(page.getByText(`Because ${tag} saw no setups.`)).toBeVisible();

  await page.getByRole('button', { name: '＋ New chat' }).first().click();
  await expect(page.getByText('Talk to your strategy agents')).toBeVisible();
  await expect(page.getByText(`Because ${tag} saw no setups.`)).toHaveCount(0);

  // The old chat is still there.
  await page.getByRole('button', { name: 'Previous chats' }).click();
  await expect(page.getByRole('button', { name: `Open chat ${ask}` })).toBeVisible();
});

// CS-E2: a strategy's chats are its own, and an empty one shows the empty state.
test('Strategy chat: only that strategy\'s chats are listed', async ({ page, request }, info) => {
  const tag = info.project.name;
  const name = `Sessions target ${tag}`;
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
  const id = (await created.json()).data.id as string;
  const mine = `Is ${name} too risky`;
  await seed(request, { strategyId: id, messages: [{ role: 'user', text: mine }, { role: 'agent', text: 'Not especially.' }] });
  await seed(request, { messages: [{ role: 'user', text: `AGENTS-TAB-ONLY ${tag}` }] });

  await connect(page);
  if (tag === 'phone-390') await page.getByRole('tab', { name: 'Strategies' }).click();
  else await page.getByRole('link', { name: 'Strategies' }).click();
  await page.getByLabel(`Chat about ${name}`).first().click();
  await expect(page.getByText(`Chat: ${name}`)).toBeVisible();
  // Reopens on its latest chat.
  await expect(page.getByText('Not especially.')).toBeVisible();

  await page.getByRole('button', { name: 'Previous chats' }).click();
  await expect(page.getByRole('button', { name: `Open chat ${mine}` })).toBeVisible();
  await expect(page.getByText(`AGENTS-TAB-ONLY ${tag}`)).toHaveCount(0);
});
