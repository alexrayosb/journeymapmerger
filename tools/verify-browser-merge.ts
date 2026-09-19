/**
 * End-to-end verification of the browser merge against the reference merge.
 *
 *   node tools/verify-browser-merge.ts --preset small --browser chromium|firefox
 *        [--url https://journeymapmerger.alexrayosbcode.workers.dev] [--priority auto|a|b]
 *
 * Drives the real page (a local Vite dev server unless --url is given) with
 * Playwright: picks the two fixture zips, merges with ?save=download so the
 * archive comes back as a browser download, saves it, then runs
 * tools/compare-archives.ts against tools/reference-merge.ts output
 * (computed once per preset+priority and cached next to the fixtures).
 * Exit code 0 only when every file matches pixel/byte-exact.
 */
import { chromium, firefox } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const preset = arg('--preset', 'small');
  const browserName = arg('--browser', 'chromium');
  const priority = arg('--priority', 'auto');
  const urlArg = arg('--url', '');
  const dir = path.resolve('fixtures', preset);
  const zipA = path.join(dir, 'A.zip');
  const zipB = path.join(dir, 'B.zip');
  if (!existsSync(zipA) || !existsSync(zipB))
    throw new Error(`fixtures missing; run: npm run fixtures -- ${preset}`);

  const reference = path.join(dir, `reference-${priority}.zip`);
  if (!existsSync(reference)) {
    console.log(`computing reference merge (${priority}) ...`);
    execFileSync(
      'node',
      ['tools/reference-merge.ts', zipA, zipB, reference, '--priority', priority],
      { stdio: 'inherit' },
    );
  }

  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let url = urlArg;
  if (url === '') {
    server = await createServer({
      configFile: path.resolve('vite.config.ts'),
      logLevel: 'warn',
      server: { port: 5190, strictPort: false },
    });
    await server.listen();
    url = server.resolvedUrls?.local[0] ?? '';
    if (url === '') throw new Error('vite did not report a URL');
  }
  const outDir = path.resolve('tools/spike/results');
  mkdirSync(outDir, { recursive: true });
  const ours = path.join(outDir, `browser-${preset}-${browserName}-${priority}.zip`);
  rmSync(ours, { force: true });

  const launcher = browserName === 'firefox' ? firefox : chromium;
  const browser = await launcher.launch({
    headless: true,
    ...(browserName === 'chromium' ? { channel: 'chromium' } : {}),
  });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.on('pageerror', (e) => {
      console.error('[pageerror]', e.message);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('[console]', m.text());
    });
    const target = `${url.replace(/\/$/, '')}/?save=download`;
    await page.goto(target);
    await page.setInputFiles('#file-a', zipA);
    await page.setInputFiles('#file-b', zipB);
    await page
      .locator('fieldset')
      .nth(0)
      .locator('.side-info')
      .filter({ hasText: /Map folder|Pick one/ })
      .waitFor();
    await page
      .locator('fieldset')
      .nth(1)
      .locator('.side-info')
      .filter({ hasText: /Map folder|Pick one/ })
      .waitFor();
    await page.locator('#priority').selectOption(priority);

    const t0 = Date.now();
    const downloadPromise = page.waitForEvent('download', { timeout: 15 * 60_000 });
    await page.getByRole('button', { name: 'Merge' }).click();
    const download = await downloadPromise;
    await download.saveAs(ours);
    await page
      .locator('.status')
      .filter({ hasText: /^Done\./ })
      .waitFor({ timeout: 60_000 });
    const status = await page.locator('.status').last().textContent();
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${browserName} ${browser.version()} on ${target}: ${seconds} s, ${(statSync(ours).size / 1e6).toFixed(1)} MB`,
    );
    console.log(`  page said: ${status ?? ''}`);
  } finally {
    await browser.close();
    await server?.close();
  }

  console.log('comparing with the reference merge ...');
  const cmp = spawnSync('node', ['tools/compare-archives.ts', ours, reference], {
    stdio: 'inherit',
  });
  process.exitCode = cmp.status ?? 1;
  console.log(
    cmp.status === 0
      ? 'PASS: browser output matches the reference merge exactly'
      : 'FAIL: differences found',
  );
}

await main();
