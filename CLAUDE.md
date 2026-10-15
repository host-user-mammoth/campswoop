# CampSwoop

Public campsite-cancellation alert service at campswoop.com, separate from the NC State monitor in the
parent folder (its own git repo: host-user-mammoth/campswoop). Nothing may use the owner's personal
email, and Google won't verify another account with the owner's phone, so the design needs no mailbox.

- `docs/index.html` (GitHub Pages) posts sign-ups to the Worker.
- `worker/` is a Cloudflare Worker at api.campswoop.com with a D1 database. It holds every email
  address, sends all email through Resend (free plan: 100 a day, so it caps itself at 90), and serves
  the confirm, stop and manage pages. Deploy with `npx wrangler deploy` from `worker/` (wrangler pinned
  in package.json).
- `alerts.py` (Python stdlib only) runs on GitHub Actions (`.github/workflows/check.yml`, self-chaining
  hourly). It gets active watches from `/api/watches` and emails through `/api/notify` and `/api/end`,
  so it never sees an address. Keep it that way: the repo and its run logs are public.
- Booking systems are classes in `SOURCES` (Recreation.gov, Firefly, Camis); link patterns are repeated
  in the Worker and the page. Firefly's unit search endpoints require reCAPTCHA; use the calendar.
- Test without secrets: `python alerts.py --check <link> <check-in> <check-out>`. For the Worker, see
  "test the Worker locally" in README.md. Python 3.12 and Node are installed.
- Before sending anything to subscribers as a whole, show the user exactly what will be sent.
