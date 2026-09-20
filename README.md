# JourneyMapMerger

Merge two [JourneyMap](https://journeymap.info/) maps of a GregTech: New
Horizons world into one combined map.

Zip each `journeymap/data/mp/<server>/` folder and drop both zips into the
page. One merged archive comes out. Tiles that only one map has are copied
as they are. Tiles that both maps have are combined, with the newer one
drawn over the older. Waypoints from both maps are kept.

Everything runs in your own browser. The zips are never uploaded. The site
is just static files with no server-side code. Cloudflare Web Analytics
counts visits. It uses no cookies and never sees your files.

Live at https://journeymapmerger.dev

Not affiliated with the JourneyMap or GTNH teams.

## Status

Usable. Merging and preview work in current Chrome, Edge, Firefox and
Safari. Very large maps save best in Chrome or Edge, which write straight
to disk.

## Develop

Requires Node 24.

```sh
npm install
npm run dev      # local dev server
npm run check    # typecheck, lint, unit tests, build
```

`npm run fixtures -- small` generates synthetic JourneyMap archives for
testing. They land in `fixtures/` and are not committed. The browser
performance rig is described in `tools/spike/README.md`. The site deploys
as an assets-only Cloudflare Worker, configured in `wrangler.jsonc`.

## License

MIT. See `LICENSE`.
