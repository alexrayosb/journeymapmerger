# JourneyMapMerger

Merge two players' [JourneyMap](https://journeymap.info/) map data from a
GregTech: New Horizons multiplayer world into one combined map.

Each player zips their `journeymap/data/mp/<server>/` folder and drops both
zips into the page. One merged archive comes out. Tiles that only one
player explored are copied as they are. Tiles that both players explored
are combined, with the newer one drawn over the older. Waypoints from both
players are kept.

Everything runs in your own browser. The zips are never uploaded. The site
is just static files with no server-side code.

Not affiliated with the JourneyMap or GTNH teams.

## Status

Early development. Not usable yet.

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
