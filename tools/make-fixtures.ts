/**
 * Synthetic JourneyMap fixture generator.
 *
 *   node tools/make-fixtures.ts <preset> [--out <dir>] [--force]
 *
 * Presets (see PRESETS below):
 *   small  two ~200-tile-file inputs, realistic tile entropy, heavy overlap
 *   big    two ~5,000-tile-file inputs, realistic entropy, ~1/3 overlap
 *   zip64  input A alone exceeds 4 GB (noise tiles ~1 MB each) so both the
 *          input and the merged output need zip64
 *
 * Output: <out>/<preset>/A.zip, B.zip, manifest.json. Everything is
 * deterministic from the preset seed, so fixtures are regenerated, never
 * committed (fixtures/ is gitignored).
 *
 * Deliberate realism (these are on purpose; keep them):
 * - The two players' world folders are named DIFFERENTLY (each player's own
 *   server-list text, \W+ -> ~), and the zips are rooted at different depths
 *   (A at journeymap/, B at the world folder). Pairing is the user's job.
 * - Multiplayer data has NO cave slices (GTNH FairPlay build). Surface layers
 *   only: day + night for DIM0, day for DIM-1 and DIM1.
 * - Tiles are painted per CHUNK (16x16 px): a tile at the edge of the
 *   explored area is partially transparent, exactly like JourneyMap's.
 *   Random "never visited" chunk holes differ per player so composites have
 *   real work to do.
 * - Nether waypoints store x/z pre-multiplied by 8 (copied verbatim, never
 *   recomputed, by the merger).
 * - Zips are created with the system Info-ZIP `zip` (store mode, -0), i.e. a
 *   tool independent of zip.js; it switches to zip64 by itself past 4 GB.
 *
 * Requires: sharp (PNG encode), the `zip` CLI (macOS/Linux ship it).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Presets

type Layer = 'day' | 'night';
type Entropy = 'realistic' | 'noise';

interface PlayerSpec {
  /** Sanitized world-folder name, as JourneyMap would derive it. */
  folder: string;
  /** Path prefix inside the zip, above the world folder ('' = folder is the root). */
  zipRoot: string;
  /** Explored-area blob center (tile coords) and radius (tiles) for DIM0. */
  center: readonly [number, number];
  radius: number;
  /** Radius (tiles) for the nether and end blobs (centered on 0,0). */
  netherRadius: number;
  endRadius: number;
  layers: readonly Layer[];
  waypoints: number;
  /** RGB tint so this player's pixels are distinguishable in composites. */
  tint: readonly [number, number, number];
}

interface Preset {
  seed: number;
  entropy: Entropy;
  /** Waypoint files present in BOTH inputs (identical content). */
  sharedWaypoints: number;
  a: PlayerSpec;
  b: PlayerSpec;
}

const PRESETS: Record<string, Preset> = {
  small: {
    seed: 1001,
    entropy: 'realistic',
    sharedWaypoints: 4,
    a: {
      folder: 'GTNH~Server~1',
      zipRoot: 'journeymap/data/mp/',
      center: [0, 0],
      radius: 5,
      netherRadius: 2,
      endRadius: 1,
      layers: ['day', 'night'],
      waypoints: 12,
      tint: [0, 0, 0],
    },
    b: {
      folder: 'our~gtnh~world~10~0~0~5~',
      zipRoot: '',
      center: [4, 3],
      radius: 5,
      netherRadius: 2,
      endRadius: 1,
      layers: ['day', 'night'],
      waypoints: 10,
      tint: [14, -4, -10],
    },
  },
  big: {
    seed: 2002,
    entropy: 'realistic',
    sharedWaypoints: 20,
    a: {
      folder: 'GTNH~Server~1',
      zipRoot: 'journeymap/data/mp/',
      center: [0, 0],
      radius: 28,
      netherRadius: 8,
      endRadius: 3,
      layers: ['day', 'night'],
      waypoints: 80,
      tint: [0, 0, 0],
    },
    b: {
      folder: 'our~gtnh~world~10~0~0~5~',
      zipRoot: '',
      center: [30, 12],
      radius: 28,
      netherRadius: 8,
      endRadius: 3,
      layers: ['day', 'night'],
      waypoints: 60,
      tint: [14, -4, -10],
    },
  },
  zip64: {
    seed: 3003,
    entropy: 'noise',
    sharedWaypoints: 2,
    a: {
      folder: 'GTNH~Server~1',
      zipRoot: 'journeymap/data/mp/',
      center: [0, 0],
      radius: 38,
      netherRadius: 0,
      endRadius: 0,
      layers: ['day'],
      waypoints: 10,
      tint: [0, 0, 0],
    },
    b: {
      folder: 'our~gtnh~world~10~0~0~5~',
      zipRoot: '',
      center: [30, 0],
      radius: 10,
      netherRadius: 0,
      endRadius: 0,
      layers: ['day'],
      waypoints: 5,
      tint: [14, -4, -10],
    },
  },
};

// ---------------------------------------------------------------------------
// Deterministic hashing / noise

/** 32-bit integer hash of up to three ints + seed -> [0, 1). */
function hash01(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise over a lattice with the given cell size (blocks). */
function valueNoise(wx: number, wz: number, cell: number, seed: number): number {
  const fx = Math.floor(wx / cell);
  const fz = Math.floor(wz / cell);
  const tx = wx / cell - fx;
  const tz = wz / cell - fz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const n00 = hash01(fx, fz, 0, seed);
  const n10 = hash01(fx + 1, fz, 0, seed);
  const n01 = hash01(fx, fz + 1, 0, seed);
  const n11 = hash01(fx + 1, fz + 1, 0, seed);
  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sz;
}

// ---------------------------------------------------------------------------
// World model

const TILE = 512;
const CHUNK = 16;

const BIOMES: readonly (readonly [number, number, number])[] = [
  [91, 138, 58], // grass
  [63, 107, 42], // forest
  [216, 201, 138], // sand
  [59, 111, 176], // water
  [125, 125, 125], // stone
  [230, 236, 240], // snow
  [110, 84, 52], // dirt / path
];

function biomeAt(wx: number, wz: number, seed: number): readonly [number, number, number] {
  const n = valueNoise(wx, wz, 384, seed + 11);
  const idx = Math.min(BIOMES.length - 1, Math.floor(n * BIOMES.length));
  return BIOMES[idx] ?? [91, 138, 58];
}

interface Blob {
  cx: number; // blocks
  cz: number;
  r: number; // blocks
  phi1: number;
  phi2: number;
}

function makeBlob(centerTiles: readonly [number, number], radiusTiles: number, seed: number): Blob {
  return {
    cx: centerTiles[0] * TILE + TILE / 2,
    cz: centerTiles[1] * TILE + TILE / 2,
    r: radiusTiles * TILE,
    phi1: hash01(1, 2, 3, seed) * Math.PI * 2,
    phi2: hash01(4, 5, 6, seed) * Math.PI * 2,
  };
}

/** Irregular disk: is this block position inside the player's explored area? */
function inBlob(b: Blob, wx: number, wz: number): boolean {
  const dx = wx - b.cx;
  const dz = wz - b.cz;
  const d = Math.hypot(dx, dz);
  if (d > b.r * 1.3) return false;
  const theta = Math.atan2(dz, dx);
  const edge =
    b.r * (1 + 0.18 * Math.sin(3 * theta + b.phi1) + 0.09 * Math.sin(7 * theta + b.phi2));
  return d <= edge;
}

// ---------------------------------------------------------------------------
// Tile painting

interface PaintOptions {
  layer: Layer;
  entropy: Entropy;
  worldSeed: number;
  playerSeed: number;
  tint: readonly [number, number, number];
}

/**
 * Paint one 512x512 RGBA tile. Returns the number of explored chunks (0 =>
 * the tile does not exist for this player).
 */
function paintTile(buf: Uint8Array, rx: number, rz: number, blob: Blob, o: PaintOptions): number {
  buf.fill(0);
  let explored = 0;
  const night = o.layer === 'night';
  const dither = o.entropy === 'noise' ? 120 : 10;
  let lcg = (hash01(rx, rz, 7, o.playerSeed) * 4294967296) >>> 0;

  for (let cz = 0; cz < TILE / CHUNK; cz++) {
    for (let cx = 0; cx < TILE / CHUNK; cx++) {
      const wx = rx * TILE + cx * CHUNK;
      const wz = rz * TILE + cz * CHUNK;
      if (!inBlob(blob, wx + CHUNK / 2, wz + CHUNK / 2)) continue;
      // Per-player "never stood here" holes, ~4% of chunks.
      if (hash01(wx, wz, 99, o.playerSeed) < 0.04) continue;
      explored++;

      const base = biomeAt(wx, wz, o.worldSeed);
      // Height shading: bilinear across the chunk from four corner samples.
      const s00 = valueNoise(wx, wz, 24, o.worldSeed + 5);
      const s10 = valueNoise(wx + CHUNK, wz, 24, o.worldSeed + 5);
      const s01 = valueNoise(wx, wz + CHUNK, 24, o.worldSeed + 5);
      const s11 = valueNoise(wx + CHUNK, wz + CHUNK, 24, o.worldSeed + 5);

      for (let py = 0; py < CHUNK; py++) {
        const tz = py / CHUNK;
        const sx0 = s00 + (s01 - s00) * tz;
        const sx1 = s10 + (s11 - s10) * tz;
        let idx = ((cz * CHUNK + py) * TILE + cx * CHUNK) * 4;
        for (let px = 0; px < CHUNK; px++) {
          const tx = px / CHUNK;
          const shade = 0.75 + 0.5 * (sx0 + (sx1 - sx0) * tx);
          for (let c = 0; c < 3; c++) {
            lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
            const noise = ((lcg >>> 24) / 255 - 0.5) * dither;
            let v = (base[c] ?? 0) * shade + (o.tint[c] ?? 0) + noise;
            if (night) v = v * 0.3 + (c === 2 ? 22 : 0);
            buf[idx + c] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
          }
          buf[idx + 3] = 255;
          idx += 4;
        }
      }
    }
  }
  return explored;
}

// ---------------------------------------------------------------------------
// Waypoints (JourneyMap 5.x: one JSON per waypoint, file name = id + .json)

interface Waypoint {
  id: string;
  name: string;
  icon: string;
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  enable: boolean;
  type: 'Normal' | 'Death';
  origin: string;
  dimensions: number[];
}

function makeWaypoint(i: number, seed: number, dim: number): Waypoint {
  const name = `${['Home', 'Base', 'Iron', 'Oil', 'Village', 'Portal', 'Ruins', 'Farm'][i % 8] ?? 'Spot'} ${String(i)}`;
  let x = Math.round((hash01(i, 1, 0, seed) - 0.5) * 6000);
  let z = Math.round((hash01(i, 2, 0, seed) - 0.5) * 6000);
  const y = 40 + Math.round(hash01(i, 3, 0, seed) * 80);
  // JourneyMap stores nether waypoints with x/z pre-multiplied by 8. Copied
  // verbatim by the merger; never "corrected".
  if (dim === -1) {
    x *= 8;
    z *= 8;
  }
  return {
    id: `${name}_${String(x)},${String(y)},${String(z)}`,
    name,
    icon: 'waypoint-normal.png',
    x,
    y,
    z,
    r: Math.floor(hash01(i, 4, 0, seed) * 256),
    g: Math.floor(hash01(i, 5, 0, seed) * 256),
    b: Math.floor(hash01(i, 6, 0, seed) * 256),
    enable: true,
    type: 'Normal',
    origin: 'JourneyMap',
    dimensions: [dim],
  };
}

// ---------------------------------------------------------------------------
// Generation

interface PlayerStats {
  tiles: number;
  waypoints: number;
  tileNames: Set<string>;
}

async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

interface TileJob {
  dim: string;
  layer: Layer;
  rx: number;
  rz: number;
  blob: Blob;
}

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0); // 2026-09-01T12:00:00Z
const DAY_MS = 86_400_000;

async function generatePlayer(
  label: 'A' | 'B',
  spec: PlayerSpec,
  preset: Preset,
  stageDir: string,
  sharedWaypoints: Waypoint[],
): Promise<PlayerStats> {
  const playerSeed = preset.seed * 7 + (label === 'A' ? 1 : 2);
  const worldDir = path.join(stageDir, spec.zipRoot, spec.folder);
  const stats: PlayerStats = { tiles: 0, waypoints: 0, tileNames: new Set() };

  const dims: { dim: string; blob: Blob; layers: readonly Layer[] }[] = [
    { dim: 'DIM0', blob: makeBlob(spec.center, spec.radius, playerSeed), layers: spec.layers },
  ];
  if (spec.netherRadius > 0) {
    dims.push({
      dim: 'DIM-1',
      blob: makeBlob([0, 0], spec.netherRadius, playerSeed + 1),
      layers: ['day'],
    });
  }
  if (spec.endRadius > 0) {
    dims.push({
      dim: 'DIM1',
      blob: makeBlob([0, 0], spec.endRadius, playerSeed + 2),
      layers: ['day'],
    });
  }

  const jobs: TileJob[] = [];
  for (const { dim, blob, layers } of dims) {
    const rTiles = Math.ceil((blob.r * 1.3) / TILE) + 1;
    const cxT = Math.floor(blob.cx / TILE);
    const czT = Math.floor(blob.cz / TILE);
    for (const layer of layers) {
      mkdirSync(path.join(worldDir, dim, layer), { recursive: true });
      for (let rz = czT - rTiles; rz <= czT + rTiles; rz++) {
        for (let rx = cxT - rTiles; rx <= cxT + rTiles; rx++) {
          jobs.push({ dim, layer, rx, rz, blob });
        }
      }
    }
  }

  const compression = preset.entropy === 'noise' ? 1 : 6;
  let done = 0;
  const bufPool: Uint8Array[] = [];
  await runPool(jobs, 8, async (job) => {
    const buf = bufPool.pop() ?? new Uint8Array(TILE * TILE * 4);
    const explored = paintTile(buf, job.rx, job.rz, job.blob, {
      layer: job.layer,
      entropy: preset.entropy,
      worldSeed: preset.seed,
      playerSeed,
      tint: spec.tint,
    });
    if (explored > 0) {
      const rel = `${job.dim}/${job.layer}/${String(job.rx)},${String(job.rz)}.png`;
      const file = path.join(worldDir, rel);
      await sharp(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), {
        raw: { width: TILE, height: TILE, channels: 4 },
      })
        .png({ compressionLevel: compression })
        .toFile(file);
      // mtime: 0-30 days before T0, 2-second aligned (zip DOS time precision).
      const ageDays = hash01(job.rx, job.rz, 13, playerSeed) * 30;
      const mtime = new Date(Math.floor((T0 - ageDays * DAY_MS) / 2000) * 2000);
      utimesSync(file, mtime, mtime);
      stats.tiles++;
      stats.tileNames.add(rel);
    }
    bufPool.push(buf);
    done++;
    if (done % 500 === 0)
      process.stdout.write(`  ${label}: ${String(done)}/${String(jobs.length)} tile positions\n`);
  });

  const wpDir = path.join(worldDir, 'waypoints');
  mkdirSync(wpDir, { recursive: true });
  const own: Waypoint[] = [];
  for (let i = 0; i < spec.waypoints; i++) {
    const dim = i % 5 === 4 ? -1 : 0;
    own.push(makeWaypoint(i + (label === 'A' ? 0 : 1000), playerSeed, dim));
  }
  for (const wp of [...own, ...sharedWaypoints]) {
    writeFileSync(path.join(wpDir, `${wp.id}.json`), JSON.stringify(wp, null, 2) + '\n');
    stats.waypoints++;
  }
  if (label === 'A') {
    writeFileSync(
      path.join(worldDir, 'colorpalette.json'),
      JSON.stringify({ name: 'Default', generated: '2026-09-01', basic: {} }, null, 2) + '\n',
    );
  }
  return stats;
}

function zipStage(stageDir: string, zipPath: string): void {
  // Info-ZIP: recurse, STORE (-0: PNG does not deflate), quiet. Extended
  // timestamps stay on (no -X) so mtimes survive with UTC precision.
  execFileSync('zip', ['-r', '-0', '-q', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const presetName = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const outRoot = outIdx >= 0 ? (args[outIdx + 1] ?? 'fixtures') : 'fixtures';
  const force = args.includes('--force');
  const preset = presetName ? PRESETS[presetName] : undefined;
  if (!presetName || !preset) {
    console.error(
      `usage: node tools/make-fixtures.ts <${Object.keys(PRESETS).join('|')}> [--out dir] [--force]`,
    );
    process.exit(2);
  }

  const outDir = path.resolve(outRoot, presetName);
  if (existsSync(path.join(outDir, 'manifest.json')) && !force) {
    console.log(`${outDir} already exists; pass --force to regenerate.`);
    return;
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const shared: Waypoint[] = [];
  for (let i = 0; i < preset.sharedWaypoints; i++)
    shared.push(makeWaypoint(5000 + i, preset.seed, 0));

  const started = Date.now();
  const manifest: Record<string, unknown> = {
    preset: presetName,
    seed: preset.seed,
    entropy: preset.entropy,
  };
  const names: Record<'A' | 'B', Set<string>> = { A: new Set(), B: new Set() };

  for (const label of ['A', 'B'] as const) {
    const spec = label === 'A' ? preset.a : preset.b;
    const stage = path.join(outDir, `.stage-${label}`);
    mkdirSync(stage, { recursive: true });
    console.log(`generating ${label} (${spec.folder}) ...`);
    const stats = await generatePlayer(label, spec, preset, stage, shared);
    names[label] = stats.tileNames;
    const zipPath = path.join(outDir, `${label}.zip`);
    console.log(
      `zipping ${label}: ${String(stats.tiles)} tiles, ${String(stats.waypoints)} waypoints ...`,
    );
    zipStage(stage, zipPath);
    rmSync(stage, { recursive: true, force: true });
    const bytes = statSync(zipPath).size;
    manifest[label] = {
      folder: spec.folder,
      zipRoot: spec.zipRoot,
      tiles: stats.tiles,
      waypoints: stats.waypoints,
      bytes,
      zip64: bytes >= 0xffffffff,
    };
    console.log(`  ${label}.zip = ${(bytes / 1e9).toFixed(2)} GB`);
  }

  let composites = 0;
  for (const n of names.A) if (names.B.has(n)) composites++;
  manifest['expected'] = {
    uniqueTiles: new Set([...names.A, ...names.B]).size,
    compositeTiles: composites,
    passThroughTiles: new Set([...names.A, ...names.B]).size - composites,
    sharedWaypoints: preset.sharedWaypoints,
    uniqueWaypoints: preset.a.waypoints + preset.b.waypoints + preset.sharedWaypoints,
  };
  manifest['generatedIn'] = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest['expected']));
}

await main();
