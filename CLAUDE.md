# CampSwoop

Public campsite-cancellation alert service at campswoop.com, separate from the NC State monitor in the
parent folder (its own git repo: host-user-mammoth/campswoop). Nothing may use the owner's personal
email, and Google won't verify another account with the owner's phone, so the design needs no mailbox.

- `docs/` (GitHub Pages) is the site. `index.html` + `assets/site.css`, `app.js` (tabs, hero, sign-up)
  and `map.js` (MapLibre 5.24 globe, loaded on the Map tab). The sign-up posts to the Worker.
- Look: warm black `#0b0a09`, ember `#ff4a1c` as the only accent. Noto Serif Display for headlines (title
  case, two lines at most), Archivo for text, buttons and big figures (wide caps), Chivo Mono for short
  labels only; hairline rules, 2 px radii. Keep to this; no extra hues, no rounded cards, no glows.
  Motion tokens are in site.css (`--ease` for entrances, `--ease-out` for presses, `--ease-drawer` for the
  phone sheet); UI changes stay under 300 ms, hover lives only under `(hover: hover) and (pointer: fine)`,
  and everything goes still under `prefers-reduced-motion`. The hero loops are graded in the files.
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
  motion-reviewer), design skills in its `.claude/skills/` (impeccable, taste-skill, redesign-skill and
  Emil Kowalski's animation and mobile-native skills; don't run impeccable's downloader CLI), and GIS MCP
  servers in its `.mcp.json`.
- The emails (alerts.py and the Worker's `emailHtml`) and the Worker's pages share the site's look; the
  alert preview clip (`docs/assets/alert.mp4`, made with vidIQ motion graphics) shows the real alert email.
- Before sending anything to subscribers as a whole, show the user exactly what will be sent.
