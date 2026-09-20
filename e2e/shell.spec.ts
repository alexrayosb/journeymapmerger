import { expect, test } from '@playwright/test';
import { ANALYTICS_HOSTS, isAnalytics } from './helpers.ts';

test('the page renders the shell and the form with no errors', async ({ page }) => {
  const errors: string[] = [];
  const blockedAnalytics: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // Ad blockers and DNS filters commonly block Cloudflare Web Analytics; the
  // page must work anyway, and that one failed load is not our error.
  page.on('requestfailed', (r) => {
    if (isAnalytics(r.url())) blockedAnalytics.push(r.url());
  });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('JourneyMapMerger');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('JourneyMapMerger');
  await expect(page.getByTestId('howto')).toBeVisible();
  await expect(page.getByTestId('file-a')).toBeVisible();
  await expect(page.getByTestId('file-b')).toBeVisible();
  await expect(page.getByTestId('merge')).toBeDisabled();
  await expect(page.getByTestId('progress')).toBeHidden();
  await expect(page.getByTestId('cancel')).toBeHidden();
  await expect(page.getByTestId('warning')).toBeHidden();
  await expect(page.getByTestId('summary')).toBeHidden();
  // Chromium says "Failed to load resource"; Firefox and WebKit name the host.
  const aboutAnalytics = (e: string): boolean =>
    e.startsWith('Failed to load resource') ||
    ANALYTICS_HOSTS.some((h) => e.includes(h.replace('https://', '')));
  const ownErrors = blockedAnalytics.length > 0 ? errors.filter((e) => !aboutAnalytics(e)) : errors;
  expect(ownErrors).toEqual([]);
});

test('the live site sends the security headers', async ({ page, baseURL }) => {
  test.skip(!process.env['E2E_BASE_URL'], 'headers come from Cloudflare, not vite preview');
  const response = await page.goto('/');
  const headers = response?.headers() ?? {};
  expect(headers['content-security-policy']).toContain("connect-src 'self'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(baseURL).toBeTruthy();
});
