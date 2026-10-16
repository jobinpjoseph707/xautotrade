import { expect, test } from '@playwright/test';
import { connect } from './helpers';

async function openTab(page: import('@playwright/test').Page, phone: boolean, name: string) {
  if (phone) await page.getByRole('tab', { name }).click();
  else await page.getByRole('link', { name }).click();
}

// YT-6 (the transcript fetch needs the internet, so the end to end flow is covered by the server tests YT-1..5;
// here we check the screen opens, validates the link, and shows the server's message)
test('Strategies > From YouTube opens, refuses a link that is not YouTube, and sends nothing', async ({ page }, info) => {
  await connect(page);
  await openTab(page, info.project.name === 'phone-390', 'Strategies');
  await page.getByRole('button', { name: 'From YouTube' }).click();
  await expect(page.getByText('Strategy from YouTube')).toBeVisible();
  await expect(page.getByText(/tested on your broker's real MT5 candles/i)).toBeVisible();

  // With no link pasted, pressing the button does nothing (the server is never asked).
  const analyse = page.getByRole('button', { name: 'Analyse video' });
  await analyse.click();
  await expect(page.getByText(/Not a recognisable YouTube URL|Paste a YouTube link first/)).toHaveCount(0);

  await page.getByPlaceholder('https://www.youtube.com/watch?v=…').fill('https://example.com/not-a-video');
  await analyse.click();
  await expect(page.getByText(/Not a recognisable YouTube URL/)).toBeVisible({ timeout: 20_000 });
  // No candidate, so no way to send anything to the Inbox.
  await expect(page.getByRole('button', { name: 'Send to Inbox' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Strategy from YouTube')).toHaveCount(0);
});
