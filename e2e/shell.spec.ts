import { expect, test } from '@playwright/test';

test('the page renders the shell and the form with no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('JourneyMapMerger');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('JourneyMapMerger');
  await expect(page.getByTestId('howto')).toBeVisible();
  await expect(page.getByTestId('file-a')).toBeVisible();
  await expect(page.getByTestId('file-b')).toBeVisible();
  await expect(page.getByTestId('merge')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('the live site sends the security headers', async ({ page, baseURL }) => {
  test.skip(!process.env['E2E_BASE_URL'], 'headers come from Cloudflare, not vite preview');
  const response = await page.goto('/');
  const headers = response?.headers() ?? {};
  expect(headers['content-security-policy']).toContain("connect-src 'self'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(baseURL).toBeTruthy();
});
