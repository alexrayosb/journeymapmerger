# Merge-pipeline spike

Throwaway measurement rig, kept so the numbers below can be re-measured
after browser or library upgrades.

It serves `web/` with Vite, launches headless Chromium or Firefox with
Playwright, and feeds two synthetic fixture zips to a minimal version of
the merge pipeline (zip.js lazy index, plan, worker-pool composites, zip.js
store-mode writer, sink). It records stage times, the memory of the whole
browser process tree measured from outside the browser with `ps` and macOS
`footprint`, and a read-back of the finished archive.

```sh
npm run fixtures -- small        # also: big, zip64   (writes fixtures/<preset>/, gitignored)
npm run spike -- --preset big --browser chromium --sink opfs
npm run spike -- --preset big --browser firefox  --sink blob
#   --sink   opfs    stream to disk via the Origin Private File System
#                    (stand-in for Chrome/Edge showSaveFilePicker streaming)
#            blob    build the archive in memory (the Firefox/Safari fallback)
#            discard count bytes only (pipeline cost without I/O)
#   --workers N      compositor workers (default min(cores, 8))
#   --headed         watch it
```

Results are written to `results/`, which is gitignored. The `big` run
prints PASS or FAIL against the project's bar of under 5 minutes of wall
time and under 1 GB of memory over the idle browser.

## Results 2026-09-19

Measured on an Apple M4 (10 cores, 24 GB, macOS 26.5) with headless
Playwright Chromium 153 and Firefox 155. The `big` preset is 5,572 plus
5,574 tiles (2.77 plus 2.76 GB in) merging to 9,336 entries and 4.55 GB
out, with 1,971 composites. The `zip64` preset is a 4.86 GB zip64 input
plus a 0.34 GB one, merging to a 4.78 GB zip64 output.

| Run | Wall | Memory over idle browser |
|---|---|---|
| big, Chromium → disk (opfs) | 28 s | 1.0–1.1 GB |
| big, Firefox → disk (opfs) | 39–43 s | 1.25–1.4 GB |
| zip64, Chromium / Firefox → disk | 22 s / 26 s | 0.8–0.9 GB |
| big, Chromium → in-memory Blob | 20 s | 1.2 GB (Chromium pages Blobs to disk) |
| big, Firefox → in-memory Blob | 49 s | 9.3 GB (~2.1× output size) |
| small (190 MB in), either browser | 1–1.5 s | 0.6–0.9 GB |

Memory is flat with archive size. It is fixed worker overhead plus byte
buffers waiting for garbage collection, not live data. Compositing is
about 5% of wall time, so the pipeline is I/O-bound. Every archive read
back with the full entry count and the right zip64 flags. Firefox's
in-memory path is the one hazard. The size warning for browsers without a
streaming save must key off predicted output size.

Notes for whoever re-runs this:

- Browsers run from a **persistent** temp profile. Playwright's default
  context is incognito-like with in-memory storage, and a multi-GB OPFS
  write hits its quota (`QuotaExceededError`) within seconds.
- Fixture zips come from the system Info-ZIP `zip` in store mode, a tool
  independent of zip.js. It switches to zip64 by itself past 4 GB.
- `footprint` is macOS-only. Elsewhere only the RSS sum is reported. It
  double-counts shared pages across browser processes, so read the delta
  over idle rather than the absolute.
- Streaming pass-through entries through a TransformStream measured about
  15% slower and no lighter than Blob-buffering each entry. Using 4 instead
  of 8 workers made no difference to wall time or memory.
