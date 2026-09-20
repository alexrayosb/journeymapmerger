/**
 * End-to-end verification of the browser merge against the reference merge.
 *
 *   node tools/verify-browser-merge.ts --preset small --browser chromium|firefox|webkit
 *        [--url https://journeymapmerger.alexrayosbcode.workers.dev] [--priority auto|a|b]
 *
 * Drives the real page (a local Vite dev server unless --url is given) with
 * Playwright: picks the two fixture zips, merges with ?save=download so the
 * archive comes back as a browser download, saves it, then runs
 * tools/compare-archives.ts against tools/reference-merge.ts output
 * (computed once per preset+priority and cached next to the fixtures).
 * Exit code 0 only when every file matches pixel/byte-exact.
 */
import { chromium, firefox, webkit } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
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

  const launcher =
    browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium;
  // A persistent (on-disk) profile: Playwright's default context is
  // incognito-like and keeps Blob storage in memory only, so a multi-GB
  // in-memory archive fails there but not in a normal browser window.
  const profileDir = mkdtempSync(path.join(os.tmpdir(), `jm-verify-${browserName}-`));
  const context = await launcher.launchPersistentContext(profileDir, {
    headless: true,
    acceptDownloads: true,
    ...(browserName === 'chromium' ? { channel: 'chromium' } : {}),
  });
  const version = context.browser()?.version() ?? 'unknown';
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => {
      console.error('[pageerror]', e.message);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('[console]', m.text());
    });
    const target = `${url.replace(/\/$/, '')}/?save=download`;
    const tStart = Date.now();
    const step = (what: string): void => {
      console.log(`  [${((Date.now() - tStart) / 1000).toFixed(1)}s] ${what}`);
    };
    await page.goto(target);
    step('page loaded');
    await page.setInputFiles('#file-a', zipA);
    step('A selected');
    await page.setInputFiles('#file-b', zipB);
    step('B selected');
    const infoA = page.locator('fieldset').nth(0).locator('.side-info');
    const infoB = page.locator('fieldset').nth(1).locator('.side-info');
    await infoA
      .filter({ hasText: /Map folder|Pick one|not a zip|No JourneyMap|Could not/ })
      .waitFor();
    step(`A read: ${(await infoA.textContent()) ?? ''}`);
    await infoB
      .filter({ hasText: /Map folder|Pick one|not a zip|No JourneyMap|Could not/ })
      .waitFor();
    step(`B read: ${(await infoB.textContent()) ?? ''}`);
    await page.locator('#priority').selectOption(priority);

    const t0 = Date.now();
    // Report what the page says as it goes, so a stall is diagnosable.
    let lastStatus = '';
    let lastChange = Date.now();
    let stalled: ((reason: 'stalled') => void) | undefined;
    const stallPromise = new Promise<'stalled'>((resolve) => {
      stalled = resolve;
    });
    const STALL_MS = 3 * 60_000;
    const statusPoll = setInterval(() => {
      void page
        .locator('.status')
        .last()
        .textContent()
        .then((text) => {
          if (text && text !== lastStatus) {
            lastStatus = text;
            lastChange = Date.now();
            console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${text}`);
          } else if (Date.now() - lastChange > STALL_MS) {
            stalled?.('stalled');
          }
        })
        .catch(() => undefined);
    }, 2000);
    const downloadPromise = page.waitForEvent('download', { timeout: 15 * 60_000 });
    const failurePromise = page
      .locator('.status')
      .filter({ hasText: /^Merge failed/ })
      .waitFor({ timeout: 15 * 60_000 })
      .then(() => 'failed' as const);
    // "Done." without a download within 2 minutes = the download never started.
    const donePromise = page
      .locator('.status')
      .filter({ hasText: /^Done\./ })
      .waitFor({ timeout: 15 * 60_000 })
      .then(
        () =>
          new Promise<'no-download'>((resolve) =>
            setTimeout(() => {
              resolve('no-download');
            }, 120_000),
          ),
      );
    await page.getByRole('button', { name: 'Merge' }).click();
    // On the in-memory path a merge over ~1 GB shows the size warning first;
    // a user clicks Continue, so does this.
    const warning = page.getByTestId('warning');
    void warning
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(async () => {
        step(`size warning shown: ${((await warning.textContent()) ?? '').slice(0, 80)}...`);
        await page.getByTestId('continue').click();
        step('continued past the warning');
      })
      .catch(() => undefined);
    const outcome = await Promise.race([
      downloadPromise,
      failurePromise,
      donePromise,
      stallPromise,
    ]);
    clearInterval(statusPoll);
    if (outcome === 'stalled') {
      throw new Error(
        `no progress for ${String(STALL_MS / 60_000)} min; page stuck at: ${lastStatus}`,
      );
    }
    if (outcome === 'failed') {
      const text = await page.locator('.status').last().textContent();
      throw new Error(`page reported: ${text ?? lastStatus}`);
    }
    if (outcome === 'no-download')
      throw new Error(`page reported done but no download started within 120 s: ${lastStatus}`);
    const download = outcome;
    await download.saveAs(ours);
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${browserName} ${version} on ${target}: ${seconds} s, ${(statSync(ours).size / 1e6).toFixed(1)} MB`,
    );
    console.log(`  page said: ${lastStatus}`);
  } finally {
    await context.close();
    await server?.close();
    rmSync(profileDir, { recursive: true, force: true });
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
