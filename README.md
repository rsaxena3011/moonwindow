# MoonWindow — Lunar Landing Site Navigator

**Pick a landing site, pick a date, and see whether the Sun will power you and Earth will answer you.**

Built for NASA Space Apps 2026 (challenge "Lunar Landing Site Navigator"). Static single-page app — no build step, no server, no live API calls from the browser.

## What it does

- **Compare table** — 8 verified CLPS landing sites for any date in 2027: daylight %, Earth-visible %, both-visible %, longest sunlit stretch, next sunrise, next Earthrise, Earth elevation range — all over the next lunar day (29.53 days). Sortable; no composite score.
- **A/B sky view** — polar azimuth/elevation plots of the Sun and Earth tracks for two sites on the selected date, with an hourly slider.
- **7-day timeline** — visibility ribbons (Sun / Earth / both) and 7-day percentages per site.
- **2D map** — equirectangular site map; click a marker to load it as Site A.

## Data — all real, all traceable

- Sun and Earth azimuth/elevation computed by **NASA JPL Horizons** (DE441 ephemeris) from live API queries made during the build (2026-11-13), 2027-01-01 → 2028-01-31, 1-hour steps, `CENTER='coord@301'` + `SITE_COORD`.
- Site coordinates are **IAU/USGS Gazetteer of Planetary Nomenclature** feature centres, except the Blue Ghost 1 landing coordinate (NASA LRO/LROC). Every site lists its source in `sites.json` and on the page.
- `generate_data.py` regenerates everything from Horizons; raw responses are kept in `data/raw/` so any value can be traced. **No data value was fabricated; no AI generated any data value.**

## Honest limits

Flat-horizon model (ideal horizon; real crater rims and ridges block low Sun/Earth). Earth visibility is geometric line-of-sight only — no relays, link budgets, or landing-safety modelling. 2027 only. Educational screening prototype, not flight-planning software.

## Use of Super Intelligence (AI)

The challenge idea is NASA's. AI-assisted tools helped draft and debug code and explore interface design; the author selected the final approach, reviewed and tested the outputs, and is responsible for the submitted work. No AI-generated images are used.

## Licence

Apache 2.0 (see LICENSE).
