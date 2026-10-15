# CampSwoop

Booked-up campground? CampSwoop emails you the moment a site opens for every night of your stay.

Sign up at **[campswoop.com](https://campswoop.com)**: pick a campground, pick your dates, and send the
email the page writes for you. That email is your sign-up; there are no accounts or passwords. You get a
confirmation within about 5 minutes, then an alert with a link to each open site whenever one frees up for
your whole stay. Reply "stop" to end alerts, or "list" to see what you're watching.

## Booking systems it can watch

| System | Covers | What counts as open |
| --- | --- | --- |
| Recreation.gov | US national parks, national forests, Army Corps lakes | one site free every night; tent/trailer/motorhome and length filters |
| Camis (GoingToCamp) | Parks Canada, BC Parks, Ontario Parks, Washington State Parks | one site free every night |
| Firefly Reservations | private campgrounds and RV parks | every night has an open site (Firefly only gives counts per night) |

Not supported: ReserveAmerica's main site (captcha) and Hipcamp (its terms forbid automated access).
Candidates for next: UseDirect/Tyler state parks (California, Florida, Ohio, Minnesota), NC State Parks and
Campspot. When someone sends a link from a booking site that isn't supported, it's counted under
`requested_sites` in `state.json`, which shows which one to add next.

## How it works

- `docs/index.html` is the sign-up page, served by GitHub Pages at campswoop.com. It searches
  Recreation.gov by name (its search API allows browser requests) and writes the sign-up email.
- Sign-ups go to **alerts@campswoop.com**. Cloudflare Email Routing forwards that address to a Gmail
  account, which `alerts.py` reads over IMAP and sends from over SMTP.
- `.github/workflows/check.yml` runs `alerts.py` every 5 minutes on GitHub Actions. Each run checks 12
  times, 5 minutes apart, then starts the next run itself, because GitHub's own schedule fires
  unreliably.
- Each run answers new emails, checks every active watch, and emails everyone watching a stay when
  something new opens for it.
- **Nobody's address is in this repo.** Each active watch is a record message under the Gmail label
  **Watching**. `state.json` only remembers which sites were open at the last check, keyed by campground
  and dates. Run logs hide email addresses.

Limits (top of `alerts.py`): 3 watches per person, 50 in total, stays up to 14 nights, up to about a
year ahead, and at most 6 alerts per stay per day. Sign-ups are accepted only when Gmail confirms the
sender's address wasn't forged, so nobody can sign someone else up.

## Running it

To **see who is watching what**, open the Gmail account and click the **Watching** label; each
message there is one watch. **Ended** holds stopped and expired watches, and **Handled** holds emails
already answered. To end a watch by hand, delete its message from Watching.

Commands (run from this folder):

```sh
python alerts.py --check https://www.recreation.gov/camping/campgrounds/232447 2027-06-12 2027-06-14
python alerts.py --check <link> <check-in> <check-out> --camping trailer --length 25
gh workflow run check.yml -R host-user-mammoth/campswoop -f action=test-email   # sample emails to the Gmail account
gh workflow run check.yml -R host-user-mammoth/campswoop                         # start checking
gh run list -R host-user-mammoth/campswoop -L 5                                   # is it running?
gh workflow disable check.yml -R host-user-mammoth/campswoop                     # stop everything
```

`--check` needs nothing but Python 3; it prints what's open for one stay.

## Setup

1. **Gmail.** Create a Gmail account for CampSwoop. Turn on 2-Step Verification, then create an App
   Password at <https://myaccount.google.com/apppasswords>.
2. **Secrets.** `gh secret set GMAIL_ADDRESS -R host-user-mammoth/campswoop` and
   `gh secret set GMAIL_APP_PASSWORD -R host-user-mammoth/campswoop`. Until both are set, runs do nothing.
3. **Email address.** In Cloudflare, open campswoop.com, go to **Email → Email Routing**, and create
   `alerts@campswoop.com` forwarding to the Gmail account. Confirm the verification email Cloudflare sends there.
4. **Website.** In Cloudflare DNS, add `CNAME @ host-user-mammoth.github.io` and
   `CNAME www host-user-mammoth.github.io`, both **DNS only** (grey cloud). GitHub Pages serves `docs/`, and
   `docs/CNAME` holds the domain.

## Adding a booking system

Write a class in the "Booking systems" section of `alerts.py` with `place_in(text)` (booking link →
campground id), `name(place)`, `booking_url(place)` and `openings(stay)`, and add it to `SOURCES`. Then add its
link pattern to `SOURCES` in `docs/index.html`.

CampSwoop is not affiliated with Recreation.gov, Parks Canada, any state or provincial park system,
Firefly Reservations or any campground.
