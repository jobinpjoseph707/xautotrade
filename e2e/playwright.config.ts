import { defineConfig } from '@playwright/test';

const SERVER_PORT = 4100;
const WEB_PORT = 8099;
export const API_KEY = 'e2e-key-0123456789abcdef012345';
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone-390', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      // Server in paper mode with a throwaway in-memory database.
      command: 'npx tsx src/index.ts',
      cwd: '../server',
      url: `${SERVER_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { BROKER: 'paper', PORT: String(SERVER_PORT), API_KEY, DB_PATH: ':memory:', MT5_COMMON_FILES: '/tmp/xat-e2e-files' },
    },
    {
      command: `npx expo start --web --port ${WEB_PORT}`,
      cwd: '../mobile',
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      env: { CI: '1', EXPO_NO_TELEMETRY: '1', BROWSER: 'none' },
    },
  ],
});
