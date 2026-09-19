# JourneyMapMerger

Merge two players' [JourneyMap](https://journeymap.info/) map data from a
GregTech: New Horizons multiplayer world into one combined map.

Each player zips their `journeymap/data/mp/<server>/` folder, both zips go
into the page, and one merged archive comes out: tiles only one player
explored are copied as-is, tiles both explored are combined with the newer
one drawn over the older, and waypoints are unioned.

Everything runs in your own browser. The zips are never uploaded; the site
is static files and has no server-side code.

Not affiliated with the JourneyMap or GTNH teams.

## Status

Early development. Not usable yet.

## Develop

Requires Node 24.

```sh
npm install
npm run dev      # local dev server
npm run check    # typecheck + lint + unit tests + build
```

`npm run fixtures -- small` generates synthetic JourneyMap archives for
testing (`fixtures/`, not committed); `tools/spike/README.md` describes the
browser performance rig. Deploys are an assets-only Cloudflare Worker
(`wrangler.jsonc`).
