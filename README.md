# CampSwoop

Booked-up campground? CampSwoop emails you the moment a site opens for every night of your stay.

Sign up at **[campswoop.com](https://campswoop.com)**: pick a campground and your dates, enter your email,
and tap the confirm link we send. That's the whole sign-up; there are no accounts or passwords. From then
on CampSwoop checks every 5 minutes and emails you a link to each open site whenever one frees up for
your whole stay. Every email has a link to stop that alert.

## Booking systems it can watch

| System | Covers | What counts as open |
| --- | --- | --- |
| Recreation.gov | US national parks, national forests, Army Corps lakes | one site free every night; tent/trailer/motorhome and length filters |
| Camis (GoingToCamp) | Parks Canada, BC Parks, Ontario Parks, Washington State Parks | one site free every night |
| Firefly Reservations | private campgrounds and RV parks | every night has an open site (Firefly only gives counts per night) |

Not supported: ReserveAmerica's main site (captcha) and Hipcamp (its terms forbid automated access).
Candidates for next: UseDirect/Tyler state parks (California, Florida, Ohio, Minnesota), NC State Parks and
Campspot. Booking sites people paste that aren't supported are counted in the `requested_sites` table.

## How it works

| Part | Where it runs | What it does |
| --- | --- | --- |
| `docs/` | GitHub Pages, campswoop.com | the site: a Watch tab (sign-up) and a Map tab (globe of every campground CampSwoop can watch, every OpenStreetMap campsite at street level, and where it's night right now); installable on phones and tablets |
| `worker/` | Cloudflare Workers, api.campswoop.com | takes sign-ups, emails confirm links, serves the confirm/stop/manage pages, holds everyone's address in its D1 database, sends all email through Resend |
| `alerts.py` | GitHub Actions, every 5 minutes | asks the Worker for active watches, checks availability, asks the Worker to email watchers |
| `tools/build_map_data.py` | run by hand | builds `docs/data/campgrounds.json`, the map's list of watchable campgrounds (Recreation.gov's API plus the four Camis sites, geocoded with Photon and cached in `tools/geocode_cache.json`) |
| `tools/qa/` | run by hand | headless-browser screenshots and sign-up tests at phone, tablet and desktop sizes (see its README) |

`alerts.py` never sees an email address, so neither do its public run logs or this public repo.
`state.json` only remembers which sites were open at each watch's last check (by watch id).
GitHub's own schedule fires unreliably, so each Actions run checks 12 times, 5 minutes apart, then starts
the next run itself.

The site's look: warm black, one ember accent, Archivo type, hairline rules. The hero plays a day or night
campsite loop depending on the visitor's local hour (`docs/assets/hero-day.mp4`, `hero-night.mp4`, from
Mixkit's free license), and the sign-up section previews an alert with a short motion-graphics clip
(`docs/assets/alert.mp4`). Everything respects `prefers-reduced-motion`.

Limits: 3 watches per person, 50 active in total, stays up to 14 nights up to about a year ahead,
10 sign-ups per hour from one internet address, 6 alerts per watch per day, and 90 emails a day overall
(Resend's free plan allows 100). Sign-ups that aren't confirmed within 7 days are dropped, and watches end
on their check-in date.

## Running it

```sh
python alerts.py --check https://www.recreation.gov/camping/campgrounds/232447 2027-06-12 2027-06-14
python alerts.py --check <link> <check-in> <check-out> --camping trailer --length 25
python alerts.py --preview                                    # sample alert email
python tools/build_map_data.py                                # refresh the map's campground list
gh run list -R host-user-mammoth/campswoop -L 5               # is it running?
gh workflow run check.yml -R host-user-mammoth/campswoop      # start it again
gh workflow disable check.yml -R host-user-mammoth/campswoop  # stop everything
```

To see who's watching what, from `worker/`:

```sh
npx wrangler d1 execute campswoop --remote --command "SELECT name, check_in, check_out, status, email FROM watches ORDER BY created DESC LIMIT 20"
npx wrangler d1 execute campswoop --remote --command "SELECT * FROM requested_sites ORDER BY count DESC"
```

## Setup

1. **Site:** Cloudflare DNS has `CNAME @` and `CNAME www` → `host-user-mammoth.github.io`, both DNS only.
   GitHub Pages serves `docs/`; `docs/CNAME` holds the domain.
2. **Worker:** from `worker/`: `npm install`, `npx wrangler login`, `npx wrangler d1 create campswoop` (put the id
   in `wrangler.toml`), `npx wrangler d1 execute campswoop --remote --file schema.sql`, `npx wrangler deploy`.
3. **Email:** in Resend (free; log in with GitHub), add and verify the domain campswoop.com and create a
   sending key; then `npx wrangler secret put RESEND_API_KEY` from `worker/`.
4. **Checker:** make a long random token and store it twice: `npx wrangler secret put API_TOKEN` (Worker) and
   `gh secret set CAMPSWOOP_API_TOKEN -R host-user-mammoth/campswoop` (GitHub). Then
   `gh workflow run check.yml -R host-user-mammoth/campswoop`.
5. **Replies (optional):** Cloudflare Email Routing can forward alerts@campswoop.com to any inbox you read.

To test the Worker locally, put `RESEND_API_KEY=log` and an `API_TOKEN` in `worker/.dev.vars` (emails are
printed instead of sent), run `npx wrangler d1 execute campswoop --local --file schema.sql` and
`npx wrangler dev`, and point the checker at it with `CAMPSWOOP_API_URL=http://localhost:8787`.

## Adding a booking system

Write a class in the "Booking systems" section of `alerts.py` with `place_in(text)` (booking link →
campground id), `name(place)`, `booking_url(place)` and `openings(stay)`, and add it to `SOURCES`. Add its
link pattern to `SOURCES` in `worker/src/index.js` and `docs/assets/app.js`, and its places to
`tools/build_map_data.py` so they appear on the map.

CampSwoop is not affiliated with Recreation.gov, Parks Canada, any state or provincial park system,
Firefly Reservations or any campground. Map data © OpenStreetMap contributors, tiles by OpenFreeMap and
OpenMapTiles.
