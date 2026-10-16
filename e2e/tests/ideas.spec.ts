import { expect, test } from '@playwright/test';
import { connect } from './helpers';

async function openTab(page: import('@playwright/test').Page, phone: boolean, name: string) {
  if (phone) await page.getByRole('tab', { name }).click();
  else await page.getByRole('link', { name }).click();
}

// K-6 (app) + K-5 (app): the Ideas sheet opens, says what status means and that pasted book text is not saved,
// and the forms refuse to send without the basics.
test('Strategies > Ideas opens, explains status, and the forms ask for the basics before sending', async ({ page }, info) => {
  await connect(page);
  await openTab(page, info.project.name === 'phone-390', 'Strategies');
  await page.getByRole('button', { name: 'Ideas' }).click();
  await expect(page.getByText('Ideas and books')).toBeVisible();
  await expect(page.getByText(/Status comes only from how strategies built from the idea actually did/)).toBeVisible();
  await expect(page.getByText(/used once and not saved/)).toBeVisible();
  await expect(page.getByText(/How the winner sized positions is thrown away/)).toBeVisible();

  const seen = new Promise<string>((resolve) =>
    page.once('dialog', (d) => {
      resolve(d.message());
      void d.dismiss();
    }),
  );
  const save = page.getByRole('button', { name: 'Save entry idea' });
  await save.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await save.click({ force: true });
  expect(await seen).toContain('Say which competition it came from.');

  await page.getByText('×', { exact: true }).click();
  await expect(page.getByText('Ideas and books')).toHaveCount(0);
});
