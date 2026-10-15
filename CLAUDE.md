# CampSwoop

Public campsite-cancellation alert service at campswoop.com, separate from the NC State monitor in the
parent folder (its own git repo: host-user-mammoth/campswoop). Nothing may use the owner's personal email.

- `alerts.py` (Python stdlib only) reads sign-up emails from the CampSwoop Gmail over IMAP, checks
  availability, and sends confirmations and alerts over SMTP. Active watches are record messages under
  the Gmail label "Watching"; the public repo must never hold subscriber addresses, and log output goes
  through `redact()`.
- Booking systems are classes in `SOURCES` (Recreation.gov, Firefly, Camis). Each adds a link pattern
  in `docs/index.html` too. The unit search endpoints on Firefly require reCAPTCHA; use the calendar
  endpoint.
- The workflow `.github/workflows/check.yml` self-chains hourly like the parent project.
- Test without Gmail: `python alerts.py --check <link> <check-in> <check-out>`. Python 3.12 is installed.
- Before sending anything to subscribers as a whole, show the user exactly what will be sent.
