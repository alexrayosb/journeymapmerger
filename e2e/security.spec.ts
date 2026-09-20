import { expect, test } from '@playwright/test';
import path from 'node:path';
import { isAnalytics, tmpDir, writeZip } from './helpers.ts';

test('a hostile folder name from a zip is rendered as text, never as markup', async ({ page }) => {
  const evil = '<img src=x onerror=alert(1)>~server';
  const zip = await writeZip(path.join(tmpDir(), 'evil.zip'), {
    [`journeymap/data/mp/${evil}/DIM0/day/0,0.png`]: 'x',
  });
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto('/');
  await page.getByTestId('file-a').setInputFiles(zip);
  const info = page.getByTestId('info-a');
  await expect(info).toContainText(evil);
  await expect(info.locator('img')).toHaveCount(0);
  await expect(page.locator('img')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('the page loads only same-origin resources plus Cloudflare Web Analytics, and has the footer notice', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? 'http://localhost:4173').origin;
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/');
  await expect(page.locator('footer')).toContainText('Not affiliated');
  await expect(page.locator('footer')).toContainText('Web Analytics counts visits');
  const others = requests.filter(
    (u) => !u.startsWith(origin) && !u.startsWith(`blob:${origin}`) && !isAnalytics(u),
  );
  expect(others).toEqual([]);
});
