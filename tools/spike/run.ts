/**
 * Merge-pipeline spike runner (Node side).
 *
 *   node tools/spike/run.ts --preset small|big|zip64 --browser chromium|firefox
 *                           [--sink opfs|blob|discard] [--workers N] [--headed]
 *
 * Serves tools/spike/web with Vite, launches the browser with Playwright,
 * feeds it fixtures/<preset>/A.zip + B.zip, runs the pipeline, and records:
 *   - stage wall times reported by the page
 *   - memory of the WHOLE browser process tree, sampled every 500 ms from
 *     OUTSIDE the browser: `ps` RSS summed (an upper bound: shared pages are
 *     counted once per process) and macOS `footprint` physical footprint
 *     (what Activity Monitor shows; no double counting). Idle baselines are
 *     recorded so the merge's own cost is the delta.
 *   - the page's plan counts vs the fixture manifest's expected counts
 * Results land in tools/spike/results/ (gitignored) and a summary prints.
 *
 * Pass bar for the `big` preset: wall < 5 min, peak < 1 GB (read as: footprint
 * delta over the idle browser).
 */
import { chromium, firefox, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';

type BrowserName = 'chromium' | 'firefox';
type Sink = 'opfs' | 'blob' | 'discard';

interface Args {
  preset: string;
  browser: BrowserName;
  sink: Sink;
  workers: number | undefined;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const browser = get('--browser') ?? 'chromium';
  const sink = get('--sink') ?? 'opfs';
  if (browser !== 'chromium' && browser !== 'firefox') throw new Error(`bad --browser ${browser}`);
  if (sink !== 'opfs' && sink !== 'blob' && sink !== 'discard')
    throw new Error(`bad --sink ${sink}`);
  const workersRaw = get('--workers');
  return {
    preset: get('--preset') ?? 'small',
    browser,
    sink,
    workers: workersRaw === undefined ? undefined : Number(workersRaw),
    headed: argv.includes('--headed'),
  };
}

interface MemSample {
  /** Sum of `ps` RSS over the tree (bytes). Upper bound. */
  rss: number;
  /** Sum of macOS physical footprint over the tree (bytes). 0 off macOS. */
  footprint: number;
  /** Sum of per-process kernel-tracked footprint peaks (bytes). 0 off macOS. */
  footprintPeak: number;
  processes: number;
}

/**
 * Pid of the top-most process whose command line mentions `marker` (the
 * browser's unique profile directory). Playwright does not expose the pid of
 * a persistent context, and a persistent (on-disk) profile is required: the
 * default context is incognito-like, with in-memory storage and a quota that
 * a multi-GB OPFS write blows through.
 */
function findRootPid(marker: string): number {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const matches = new Map<number, number>(); // pid -> ppid
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m?.[3]?.includes(marker)) matches.set(Number(m[1]), Number(m[2]));
  }
  for (const [pid, ppid] of matches) if (!matches.has(ppid)) return pid;
  throw new Error(`no browser process mentions ${marker}`);
}

/** Process tree (pids + RSS) of a root process, via `ps`. */
function processTree(rootPid: number): { pids: number[]; rssBytes: number } {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    rss.set(pid, Number(parts[2]));
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const pids: number[] = [];
  let total = 0;
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) continue;
    pids.push(pid);
    total += rss.get(pid) ?? 0;
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return { pids, rssBytes: total * 1024 };
}

/** One memory sample of the browser's whole process tree. */
function sampleMemory(rootPid: number): MemSample {
  const tree = processTree(rootPid);
  let footprint = 0;
  let footprintPeak = 0;
  try {
    const out = execFileSync(
      '/usr/bin/footprint',
      ['-f', 'bytes', '--noCategories', ...tree.pids.map(String)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const m of out.matchAll(/phys_footprint: (\d+) B/g)) footprint += Number(m[1]);
    for (const m of out.matchAll(/phys_footprint_peak: (\d+) B/g)) footprintPeak += Number(m[1]);
  } catch {
    // footprint is macOS-only; zeros elsewhere.
  }
  return { rss: tree.rssBytes, footprint, footprintPeak, processes: tree.pids.length };
}

interface Manifest {
  expected?: {
    uniqueTiles: number;
    compositeTiles: number;
    passThroughTiles: number;
    uniqueWaypoints: number;
  };
  A?: { bytes: number };
  B?: { bytes: number };
}

interface PageResult {
  ua: string;
  hardwareConcurrency: number;
  workers: number;
  inflight: number;
  sink: Sink;
  plan: { passThrough: number; composite: number; keepA: number; skipped: number };
  timesMs: { index: number; plan: number; merge: number; close: number; total: number };
  compositeMs: { decode: number; draw: number; encode: number };
  outputBytes: number;
  outputEntries: number;
  readback: { bytes: number; entries: number; zip64: boolean };
  jsHeapPeakBytes: number | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixtureDir = path.resolve('fixtures', args.preset);
  const pathA = path.join(fixtureDir, 'A.zip');
  const pathB = path.join(fixtureDir, 'B.zip');
  if (!existsSync(pathA) || !existsSync(pathB)) {
    throw new Error(`fixtures missing; run: node tools/make-fixtures.ts ${args.preset}`);
  }
  const manifest = JSON.parse(
    readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'),
  ) as Manifest;

  const server = await createServer({
    configFile: false,
    root: path.resolve('tools/spike/web'),
    cacheDir: path.resolve('node_modules/.vite-spike'),
    logLevel: 'warn',
    server: { port: 5199, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('vite did not report a URL');

  const launcher = args.browser === 'chromium' ? chromium : firefox;
  const profileDir = mkdtempSync(path.join(os.tmpdir(), `jm-spike-${args.browser}-`));
  const context: BrowserContext = await launcher.launchPersistentContext(profileDir, {
    headless: !args.headed,
    // Full Chromium in the new headless mode (not the stripped headless shell),
    // so the number reflects the real browser's code paths.
    ...(args.browser === 'chromium' ? { channel: 'chromium' } : {}),
  });
  const rootPid = findRootPid(profileDir);
  const version = context.browser()?.version() ?? 'unknown';

  let peakRss = 0;
  let peakFootprint = 0;
  let sampleCount = 0;
  let lastSample: MemSample | undefined;
  let idle: MemSample | undefined;
  const take = (): void => {
    const now = sampleMemory(rootPid);
    lastSample = now;
    sampleCount++;
    if (now.rss > peakRss) peakRss = now.rss;
    if (now.footprint > peakFootprint) peakFootprint = now.footprint;
  };
  const sampler = setInterval(take, 500);

  const startedAt = new Date();
  let result: PageResult | undefined;
  let failure: string | undefined;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('console', (m) => {
      const text = m.text();
      if (text.startsWith('[spike]') && !text.includes('"ua"')) console.log(`  ${text}`);
    });
    page.on('pageerror', (e) => {
      console.error('  [pageerror]', e.message);
    });
    await page.goto(url);
    await page.setInputFiles('#fileA', pathA);
    await page.setInputFiles('#fileB', pathB);
    idle = sampleMemory(rootPid);
    console.log(
      `${args.browser} ${version} idle: footprint ${(idle.footprint / 1e6).toFixed(0)} MB, RSS-sum ${(idle.rss / 1e6).toFixed(0)} MB, ${String(idle.processes)} processes; running ${args.preset} → ${args.sink}`,
    );
    const opts: { sink: Sink; workers?: number } = { sink: args.sink };
    if (args.workers !== undefined) opts.workers = args.workers;
    result = await page.evaluate(
      (o) =>
        (globalThis as unknown as { spike: { run(o: unknown): Promise<PageResult> } }).spike.run(o),
      opts,
    );
    take(); // final sample while everything is still alive
  } catch (err) {
    failure = err instanceof Error ? (err.stack ?? err.message) : String(err);
  } finally {
    clearInterval(sampler);
    await context.close().catch(() => undefined);
    await server.close();
    rmSync(profileDir, { recursive: true, force: true });
  }

  const record = {
    startedAt: startedAt.toISOString(),
    preset: args.preset,
    browser: args.browser,
    browserVersion: version,
    headless: !args.headed,
    sink: args.sink,
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      memGB: +(os.totalmem() / 2 ** 30).toFixed(0),
      platform: `${os.platform()} ${os.release()}`,
    },
    fixture: { A: manifest.A?.bytes, B: manifest.B?.bytes, expected: manifest.expected },
    memory: {
      idle,
      peakRssBytes: peakRss,
      peakFootprintBytes: peakFootprint,
      footprintPeakSumBytes: lastSample?.footprintPeak ?? 0,
      samples: sampleCount,
    },
    result,
    failure,
  };
  mkdirSync(path.resolve('tools/spike/results'), { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outFile = path.resolve(
    'tools/spike/results',
    `${args.preset}-${args.browser}-${args.sink}-${stamp}.json`,
  );
  writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');

  if (failure !== undefined || result === undefined) {
    console.error(`FAILED: ${failure ?? 'no result'}`);
    console.error(`(record: ${outFile})`);
    process.exitCode = 1;
    return;
  }

  const exp = manifest.expected;
  const planOk =
    exp?.compositeTiles === result.plan.composite &&
    exp.uniqueTiles + exp.uniqueWaypoints + 1 === result.outputEntries && // +1 colorpalette.json
    (result.readback.entries === -1 || result.readback.entries === result.outputEntries);
  const mb = (n: number): string => (n / 1e6).toFixed(0);
  const perTile = (n: number): string => (n / Math.max(1, result.plan.composite)).toFixed(1);
  const idleFp = idle?.footprint ?? 0;
  const idleRss = idle?.rss ?? 0;
  console.log('');
  console.log(
    `preset ${args.preset} | ${args.browser} ${version} | sink ${args.sink} | workers ${String(result.workers)} inflight ${String(result.inflight)}`,
  );
  console.log(
    `  inputs      A ${mb(manifest.A?.bytes ?? 0)} MB + B ${mb(manifest.B?.bytes ?? 0)} MB → output ${mb(result.outputBytes)} MB, ${String(result.outputEntries)} entries; read back ${String(result.readback.entries)} entries, zip64=${String(result.readback.zip64)}`,
  );
  console.log(
    `  plan        ${String(result.plan.passThrough)} pass-through, ${String(result.plan.composite)} composite, ${String(result.plan.keepA)} keep-A ${planOk ? '(matches manifest)' : '(MISMATCH vs manifest!)'}`,
  );
  console.log(
    `  wall        total ${(result.timesMs.total / 1000).toFixed(1)} s = index ${(result.timesMs.index / 1000).toFixed(1)} + merge ${(result.timesMs.merge / 1000).toFixed(1)} + close ${(result.timesMs.close / 1000).toFixed(1)}`,
  );
  console.log(
    `  composite   per tile: decode ${perTile(result.compositeMs.decode)} ms, draw ${perTile(result.compositeMs.draw)} ms, encode ${perTile(result.compositeMs.encode)} ms (worker-side, summed across workers)`,
  );
  console.log(
    `  memory      footprint peak ${mb(peakFootprint)} MB = idle ${mb(idleFp)} + delta ${mb(peakFootprint - idleFp)} MB; per-process kernel peaks summed ${mb(lastSample?.footprintPeak ?? 0)} MB`,
  );
  console.log(
    `              RSS-sum peak ${mb(peakRss)} MB = idle ${mb(idleRss)} + delta ${mb(peakRss - idleRss)} MB; ${String(sampleCount)} samples${result.jsHeapPeakBytes !== null ? `; JS heap peak ${mb(result.jsHeapPeakBytes)} MB` : ''}`,
  );
  if (args.preset === 'big') {
    const wallOk = result.timesMs.total < 5 * 60 * 1000;
    const memOk = peakFootprint - idleFp < 1e9;
    console.log(
      `  PASS BAR    wall < 5 min: ${wallOk ? 'PASS' : 'FAIL'}; footprint delta < 1 GB: ${memOk ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log(`  record      ${path.relative(process.cwd(), outFile)}`);
  if (!planOk) process.exitCode = 1;
}

await main();
