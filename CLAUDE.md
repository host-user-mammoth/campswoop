# CampSwoop

Public campsite-cancellation alert service at campswoop.com, separate from the NC State monitor in the
parent folder (its own git repo: host-user-mammoth/campswoop). Nothing may use the owner's personal
email, and Google won't verify another account with the owner's phone, so the design needs no mailbox.

- `docs/` (GitHub Pages) is the site. `index.html` + `assets/site.css`, `app.js` (tabs, hero, sign-up)
  and `map.js` (MapLibre 5.24 globe, loaded on the Map tab). The sign-up posts to the Worker.
- Look: warm black `#0b0a09`, ember `#ff4a1c` as the only accent, Archivo (display at font-stretch 125%,
  uppercase; body 100%), hairline rules, 2 px radii. Keep to this; no extra hues, no rounded cards.
  Motion: 0.9 s `cubic-bezier(.16,1,.3,1)` reveals, one signature moment per view, everything collapses
  under `prefers-reduced-motion`.
- The map: OpenFreeMap "dark" style restyled in `restyle()`, globe projection, clusters from
  `docs/data/campgrounds.json` (built by `tools/build_map_data.py`; refs map to booking links in
  `bookingLink()`), OpenStreetMap campsites straight from the vector tiles (poi class `campsite`, only
  present from zoom 14), and a night polygon computed from the sun's position. On phones, details open
  in the bottom sheet, not a popup. MapLibre's stylesheet loads after ours, so its selectors are
  overridden under `.mapview` only.
- `worker/` is a Cloudflare Worker at api.campswoop.com with a D1 database. It holds every email
  address, sends all email through Resend (free plan: 100 a day, so it caps itself at 90), and serves
  the confirm, stop and manage pages. Deploy with `npx wrangler deploy` from `worker/`.
- `alerts.py` (Python stdlib only) runs on GitHub Actions (`.github/workflows/check.yml`, self-chaining
  hourly). It gets active watches from `/api/watches` and emails through `/api/notify` and `/api/end`,
  so it never sees an address. Keep it that way: the repo and its run logs are public.
- Booking systems are classes in `SOURCES` (Recreation.gov, Firefly, Camis); link patterns are repeated
  in the Worker and `app.js`. Firefly's unit search endpoints require reCAPTCHA; use the calendar.
- Test without secrets: `python alerts.py --check <link> <check-in> <check-out>`. For the Worker, see
  "test the Worker locally" in README.md. For the site, `tools/qa` (Playwright) screenshots every size
  and drives the sign-up with a mocked API; its README has the commands. Python 3.12 and Node are
  installed.
- Review agents live in the parent folder's `.claude/agents/` (gis-mapping, web-design-critic,
  motion-reviewer) and GIS MCP servers in the parent's `.mcp.json`.
- Before sending anything to subscribers as a whole, show the user exactly what will be sent.
