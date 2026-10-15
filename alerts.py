#!/usr/bin/env python3
"""CampSwoop checker: email people when a booked-up campground opens a site for their dates.

People sign up on campswoop.com (docs/): they pick a campground and dates, enter their email, and tap
the confirm link the CampSwoop API emails them. The API (worker/, a Cloudflare Worker at
api.campswoop.com) keeps the email addresses and sends all email through Resend. Every few minutes
this script asks the API for the active watches, checks each campground, and asks the API to email a
watcher when a site opens for every night of their stay. It never sees an email address, so neither
do its logs or this public repo. state.json keeps which sites were open at each watch's last check.
Standard library only.

Usage:
  python alerts.py              # check every active watch and send alerts
  python alerts.py --dry-run    # check and print the emails it would send; send and change nothing
  python alerts.py --check LINK CHECK_IN CHECK_OUT [--camping tent|trailer|motorhome|rv] [--length FT]
                                # print what's open for one stay; needs no API token
  python alerts.py --preview    # print a sample alert email

Environment (repo secret):
  CAMPSWOOP_API_TOKEN   shared with the Worker, where it's the API_TOKEN secret
"""

import argparse
import datetime as dt
import gzip
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

# --- Settings -----------------------------------------------------------------

SIGNUP_PAGE = "https://campswoop.com/"
API_URL = os.environ.get("CAMPSWOOP_API_URL", "https://api.campswoop.com")  # override to test a local Worker
MAX_ALERTS_PER_WATCH_PER_DAY = 6  # stops a flapping campground from flooding an inbox
SITES_LISTED = 6                  # open sites linked in one alert

HERE = Path(__file__).parent
STATE_FILE = HERE / "state.json"
CACHE_DIR = HERE / ".cache"  # campsite details, reused between checks on the same runner
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")

CAMPING = {"any": "any site", "tent": "a tent", "trailer": "a trailer", "motorhome": "a motorhome or van",
           "rv": "an RV"}


def today():
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.now(ZoneInfo("America/New_York")).date()
    except Exception:  # no time zone database available
        return dt.date.today()


# --- Stays --------------------------------------------------------------------

@dataclass(frozen=True)
class Stay:
    source: str           # key in SOURCES
    place: str            # campground id within that source
    check_in: dt.date
    check_out: dt.date
    camping: str = "any"  # key in CAMPING
    length: int = 0       # rig length in feet; 0 when not given

    @property
    def key(self):
        return ":".join([self.source, self.place, self.check_in.isoformat(), self.check_out.isoformat(),
                         self.camping, str(self.length)])

    @property
    def nights(self):
        return [self.check_in + dt.timedelta(days=i) for i in range((self.check_out - self.check_in).days)]

    def dates(self):
        """E.g. "Fri Jun 12 – Sun Jun 14, 2027 (2 nights)"."""
        count = len(self.nights)
        return f"{day_name(self.check_in)} – {day_name(self.check_out)}, {self.check_out.year} " \
               f"({count} night{'' if count == 1 else 's'})"

    def short_dates(self):
        """E.g. "Jun 12–14" or "Jun 30–Jul 2"."""
        start, end = self.check_in, self.check_out
        return f"{start:%b} {start.day}–{end.day}" if start.month == end.month else \
               f"{start:%b} {start.day}–{end:%b} {end.day}"

    def rig(self):
        if self.camping == "any":
            return "any site"
        return CAMPING[self.camping] + (f", {self.length} ft" if self.length else "")


@dataclass(frozen=True)
class Opening:
    id: str     # stable id, so the next check can tell what's new
    label: str  # e.g. "Site 044 (Upper Pines loop)"
    url: str    # where to book it


def day_name(day):
    return f"{day:%a %b} {day.day}"


# --- HTTP ---------------------------------------------------------------------

class NotFound(Exception):
    pass


def fetch(url, data=None, headers=None):
    """GET (or POST form data) and return the body as text. Retries network errors, not 4xx."""
    if isinstance(data, dict):
        data = urllib.parse.urlencode(data).encode()
    request = urllib.request.Request(url, data=data, headers={
        "User-Agent": USER_AGENT, "Accept-Encoding": "gzip", **(headers or {})})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body.decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise NotFound(url) from error
            if error.code < 500 and error.code != 429 or attempt == 2:
                raise
            failure = error
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt == 2:
                raise
            failure = error
        print(f"{url} failed ({failure}); retrying", file=sys.stderr)
        time.sleep(5 * (attempt + 1))


def fetch_json(url, **kwargs):
    return json.loads(fetch(url, **kwargs))


def cached(name, max_age, load):
    """Return load() and keep it in CACHE_DIR for max_age seconds."""
    path = CACHE_DIR / f"{name}.json"
    if path.exists() and time.time() - path.stat().st_mtime < max_age:
        return json.loads(path.read_text())
    value = load()
    CACHE_DIR.mkdir(exist_ok=True)
    path.write_text(json.dumps(value))
    return value


# --- Booking systems ----------------------------------------------------------
# Each one turns a pasted booking link into a campground id, names it, and lists what's open for
# a stay. Add a class here (and to SOURCES) to support another booking system.

TENTS = re.compile(r"\btent", re.I)
TRAILERS = re.compile(r"trailer|fifth wheel|pop ?up", re.I)
MOTORHOMES = re.compile(r"\brv\b|motor ?home|camper ?van|caravan|pickup camper|truck camper", re.I)


class Source:
    title = ""
    filters_camping = True  # False: the booking system can't tell tent sites from RV sites, so watch any site

    def site_name(self, place):
        """The booking site's name, as shown in emails."""
        return self.title

    def check_request(self, stay):
        """Raise ValueError, with a message for the watcher, if this stay can't be watched here."""


class RecreationGov(Source):
    """US national parks, national forests, Army Corps lakes and other federal campgrounds."""
    title = "Recreation.gov"
    API = "https://www.recreation.gov/api"
    LINK = re.compile(r"recreation\.gov/camping/(campgrounds|campsites)/(\d+)", re.I)
    # Sites that only a group, a horse camp or park staff can book.
    EXCLUDED_TYPES = ("GROUP", "MANAGEMENT", "EQUESTRIAN")

    def __init__(self):
        self.months = {}

    def place_in(self, text):
        match = self.LINK.search(text)
        if not match:
            return None
        kind, number = match.groups()
        if kind.lower() == "campsites":  # a link to one site: watch its whole campground
            return str(fetch_json(f"{self.API}/camps/campsites/{number}")["campsite"]["facility_id"])
        return number

    def name(self, place):
        campground = fetch_json(f"{self.API}/camps/campgrounds/{place}")["campground"]
        states = {a.get("state_code") for a in campground.get("addresses") or [] if a.get("state_code")}
        return campground["facility_name"] + (f", {states.pop()}" if len(states) == 1 else "")

    def booking_url(self, place):
        return f"https://www.recreation.gov/camping/campgrounds/{place}"

    def month(self, place, first_day):
        if (place, first_day) not in self.months:
            start = urllib.parse.quote(f"{first_day:%Y-%m-%d}T00:00:00.000Z")
            self.months[place, first_day] = fetch_json(
                f"{self.API}/camps/availability/campground/{place}/month?start_date={start}")["campsites"]
        return self.months[place, first_day]

    def equipment(self, place):
        """{campsite_id: [[equipment name, max length ft], ...]}; a length of 0 means no limit given."""
        def load():
            data = fetch_json(f"{self.API}/search/campsites?start=0&size=1000&fq=asset_id%3A{place}"
                              "&include_non_site_specific_campsites=true")
            return {site["campsite_id"]: [[item["equipment_name"], item.get("max_length") or 0]
                                          for item in site.get("permitted_equipment") or []]
                    for site in data["campsites"]}
        return cached(f"recgov-equipment-{place}", 6 * 3600, load)

    def fits(self, equipment, stay):
        if stay.camping == "tent":
            return any(TENTS.search(name) for name, _ in equipment)
        patterns = {"trailer": [TRAILERS], "motorhome": [MOTORHOMES], "rv": [TRAILERS, MOTORHOMES]}[stay.camping]
        lengths = [length for name, length in equipment if any(p.search(name) for p in patterns)]
        if not lengths and stay.camping == "trailer":  # some sites list only a generic "RV"
            lengths = [length for name, length in equipment if re.search(r"\brv\b", name, re.I)]
        return any(not stay.length or not length or length >= stay.length for length in lengths)

    def openings(self, stay):
        sites = {}
        for first_day in sorted({night.replace(day=1) for night in stay.nights}):
            for site_id, site in self.month(stay.place, first_day).items():
                sites.setdefault(site_id, {**site, "availabilities": {}})["availabilities"].update(
                    site.get("availabilities") or {})
        equipment = self.equipment(stay.place) if stay.camping != "any" else None
        found = []
        for site_id, site in sites.items():
            kind = (site.get("campsite_type") or "").upper()
            if site.get("type_of_use") != "Overnight" or any(word in kind for word in self.EXCLUDED_TYPES):
                continue
            if equipment is not None and not self.fits(equipment.get(site_id, []), stay):
                continue
            if all(site["availabilities"].get(f"{night}T00:00:00Z") == "Available" for night in stay.nights):
                loop = f" ({site['loop']})" if site.get("loop") else ""
                found.append(Opening(site_id, f"Site {site.get('site') or site_id}{loop}",
                                     f"https://www.recreation.gov/camping/campsites/{site_id}"))
        return sorted(found, key=lambda opening: opening.label)


class Firefly(Source):
    """Private campgrounds and RV parks that book through Firefly Reservations."""
    title = "Firefly Reservations"
    LINK = re.compile(r"fireflyreservations\.com/reserve/property/([A-Za-z0-9_-]+)", re.I)
    CALENDAR = "https://app.fireflyreservations.com/Reserve/GetPropertyAvailabilityCalendar"
    # Calendar cells and their open-site counts ("3", "10+"; full nights have no count).
    DAY_CELL = re.compile(r'<div class="day( [^"]*)?">(.*?)(?=<div class="day[ "]|\Z)', re.S)
    DAY_NUMBER = re.compile(r'class="day-number">\s*(\d+)')
    SITE_COUNT = re.compile(r'class="count[^"]*"[^>]*>\s*([^<]*?)\s*<')
    # Firefly's equipment codes: travel trailer and Class C motorhome stand in for each kind.
    EQUIPMENT = {"trailer": "TT", "rv": "TT", "motorhome": "MHC"}

    def __init__(self):
        self.properties = {}
        self.months = {}

    def place_in(self, text):
        match = self.LINK.search(text)
        return match.group(1) if match else None

    def property(self, slug):
        """{"guid", "name", "units"} from the property's booking page; units are its unit types, e.g. ["RV"]."""
        if slug not in self.properties:
            page = fetch(self.booking_url(slug))
            # An unknown property still loads, titled "Firefly | Property not found" and without this input.
            guid = re.search(r'name="PropertyGUID" value="([0-9a-fA-F-]{36})"', page)
            if not guid:
                raise NotFound(slug)
            title = re.search(r"<title>\s*Reserve \|\s*([^<]+?)\s*</title>", page)
            units = re.search(r'<select name="UnitType"[^>]*>(.*?)</select>', page, re.S)
            self.properties[slug] = {
                "guid": guid.group(1),
                "name": html.unescape(title.group(1)) if title else slug,
                "units": re.findall(r'<option value="([^"]+)"', units.group(1)) if units else ["RV"],
            }
        return self.properties[slug]

    def name(self, slug):
        return self.property(slug)["name"]

    def unit_type(self, stay):
        units = self.property(stay.place)["units"]
        if stay.camping == "tent":
            return next((unit for unit in units if TENTS.search(unit)), None)
        if stay.camping == "any":
            return units[0] if units else "RV"
        return next((unit for unit in units if unit.upper() == "RV"), None)

    def check_request(self, stay):
        if not self.unit_type(stay):
            raise ValueError(f"{self.name(stay.place)} doesn't take {CAMPING[stay.camping].split()[-1]} "
                             "bookings online. Sign up again with \"any site\".")

    def booking_url(self, slug):
        return f"https://app.fireflyreservations.com/reserve/property/{slug}"

    def month(self, stay, first_day):
        """{date: open-site count label} for every night of the month."""
        key = (stay.place, stay.camping, stay.length, first_day)
        if key not in self.months:
            unit = self.unit_type(stay)
            if not unit:
                raise ValueError(f"no {stay.camping} unit type at {stay.place}")
            search = {"PropertyGUID": self.property(stay.place)["guid"], "ReservationType": "S", "Adults": 2,
                      "Children": 0, "Pets": 0, "Vehicles": 1, "DurationMode": "NIGHTLY", "UnitType": unit}
            if unit.upper() == "RV":  # RV searches need a rig; "any site" uses a small travel trailer
                search.update(RVLength=stay.length or 20, RVEquipmentType=self.EQUIPMENT.get(stay.camping, "TT"))
            form = {f"searchParams[{name}]": value for name, value in search.items()}
            form["firstDayOfMonth"] = first_day.strftime("%m/%d/%Y")
            page = fetch(self.CALENDAR, data=form, headers={"X-Requested-With": "XMLHttpRequest"})
            self.months[key] = self.parse(page, first_day)
        return self.months[key]

    def parse(self, page, first_day):
        shown = re.search(r'data-firstdayofmonth="(\d{4}-\d{2}-\d{2})"', page)
        if not shown or dt.date.fromisoformat(shown.group(1)) != first_day:
            raise ValueError(f"Firefly calendar for {first_day:%b %Y} is missing or shows the wrong month")
        nights = {}
        for classes, cell in self.DAY_CELL.findall(page):
            number = self.DAY_NUMBER.search(cell)
            if "other-month" in (classes or "") or not number:
                continue
            count = self.SITE_COUNT.search(cell)
            nights[first_day.replace(day=int(number.group(1)))] = count.group(1) if count else "0"
        if len(nights) < 28:
            raise ValueError(f"parsed only {len(nights)} nights from Firefly for {first_day:%b %Y}")
        return nights

    def openings(self, stay):
        counts = {}
        for first_day in sorted({night.replace(day=1) for night in stay.nights}):
            counts.update(self.month(stay, first_day))
        labels = [counts.get(night, "0") for night in stay.nights]
        if not all(re.fullmatch(r"\d+\+?", label) and int(label.rstrip("+")) > 0 for label in labels):
            return []
        # Firefly only gives a count per night, not which site, so this is one opening for the stay.
        nightly = ", ".join(f"{day_name(night)}: {label} open" for night, label in zip(stay.nights, labels))
        return [Opening("open", f"Every night has a site ({nightly}); pick one that's free all nights",
                        self.booking_url(stay.place))]


class Camis(Source):
    """Parks Canada, BC Parks, Ontario Parks, Washington State Parks and other GoingToCamp sites."""
    title = "Parks Canada, BC Parks, Ontario Parks and Washington State Parks"
    filters_camping = False  # equipment categories differ on every Camis site
    HOSTS = {"reservation.pc.gc.ca": "Parks Canada", "camping.bcparks.ca": "BC Parks",
             "reservations.ontarioparks.ca": "Ontario Parks", "washington.goingtocamp.com": "Washington State Parks"}
    LINK = re.compile(r"https?://((?:[\w-]+\.)*(?:goingtocamp\.com|pc\.gc\.ca|bcparks\.ca|ontarioparks\.ca))(/[^\s<>\"']*)?", re.I)
    AVAILABLE, PARTLY_AVAILABLE = 0, 7  # Camis availability codes for a night

    def place_in(self, text):
        """"host/resourceLocationId/mapId" from a Camis booking link."""
        match = self.LINK.search(text)
        if not match:
            return None
        host = match.group(1).lower()
        query = urllib.parse.parse_qs(urllib.parse.urlparse(match.group(2) or "").query)
        location = (query.get("resourceLocationId") or [""])[0]
        if not re.fullmatch(r"-?\d+", location):
            raise ValueError(f"That {self.HOSTS.get(host, host)} link doesn't say which park. Open the park on "
                             "the booking site, search any dates, and send the link from the results page.")
        map_id = (query.get("mapId") or [""])[0]
        if not re.fullmatch(r"-?\d+", map_id):
            map_id = str(self.location(host, location)["rootMapId"])
        return f"{host}/{location}/{map_id}"

    def locations(self, host):
        def load():
            return {str(place["resourceLocationId"]): {"name": place["localizedValues"][0]["fullName"],
                                                       "rootMapId": place["rootMapId"]}
                    for place in fetch_json(f"https://{host}/api/resourceLocation")}
        return cached(f"camis-locations-{host}", 86400, load)

    def location(self, host, location):
        try:
            return self.locations(host)[location]
        except KeyError:
            raise NotFound(location)

    def name(self, place):
        host, location, _ = place.split("/")
        return self.location(host, location)["name"]

    def site_name(self, place):
        host = place.split("/")[0]
        return self.HOSTS.get(host, host)

    def booking_url(self, place, stay=None, map_id=None):
        host, location, root = place.split("/")
        params = {"resourceLocationId": location, "mapId": map_id or root, "searchTabGroupId": 0, "bookingCategoryId": 0}
        if stay:
            params.update(startDate=stay.check_in.isoformat(), endDate=stay.check_out.isoformat(),
                          nights=len(stay.nights), isReserving="true")
        return f"https://{host}/create-booking/results?" + urllib.parse.urlencode(params)

    def site_names(self, host, location):
        def load():
            resources = fetch_json(f"https://{host}/api/resourcelocation/resources?resourceLocationId={location}")
            return {key: (value.get("localizedValues") or [{}])[0].get("name") or key for key, value in resources.items()}
        return cached(f"camis-sites-{host}-{location}", 86400, load)

    def openings(self, stay):
        host, location, root = stay.place.split("/")
        params = {"bookingCategoryId": 0, "equipmentCategoryId": -32768, "subEquipmentCategoryId": -32768,
                  "startDate": stay.check_in.isoformat(), "endDate": stay.nights[-1].isoformat(),  # last night
                  "getDailyAvailability": "true", "isReserving": "true", "filterData": "[]",
                  "peopleCapacityCategoryCounts": "[]", "numEquipment": 0}
        found, queue, seen = [], [root], set()
        while queue and len(seen) < 60:  # a park's map links to its loops, which can link further
            map_id = queue.pop(0)
            if map_id in seen:
                continue
            seen.add(map_id)
            data = fetch_json(f"https://{host}/api/availability/map?" + urllib.parse.urlencode({"mapId": map_id, **params}))
            # Only open loops that have something free every night.
            queue += [child for child, nights in (data.get("mapLinkAvailabilities") or {}).items()
                      if all(night in (self.AVAILABLE, self.PARTLY_AVAILABLE) for night in nights)]
            for site, nights in (data.get("resourceAvailabilities") or {}).items():
                if len(nights) == len(stay.nights) and all(n.get("availability") == self.AVAILABLE for n in nights):
                    found.append(Opening(site, f"Site {self.site_names(host, location).get(site, site)}",
                                         self.booking_url(stay.place, stay, map_id)))
        return sorted(found, key=lambda opening: opening.label)


SOURCES = {"recgov": RecreationGov(), "firefly": Firefly(), "camis": Camis()}


# --- Emails -------------------------------------------------------------------
# The API adds the stop and manage links to the end of every email it sends for us.

def html_page(paragraphs):
    """A plain, phone-friendly HTML email from already-escaped HTML paragraphs."""
    return ('<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
            f'font-size:16px;line-height:1.5;color:#1d2a20;max-width:560px">{"".join(paragraphs)}</div>')


def button(url, label):
    return (f'<p><a href="{html.escape(url)}" style="display:inline-block;background:#2f6b3a;color:#fff;'
            f'text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">{html.escape(label)}</a></p>')


def small(text_html):
    return f'<p style="font-size:13px;color:#5b6b5e">{text_html}</p>'


def openings_text(openings, place_url):
    lines = [f"  {opening.label}: {opening.url}" for opening in openings[:SITES_LISTED]]
    if len(openings) > SITES_LISTED:
        lines.append(f"  ...and {len(openings) - SITES_LISTED} more: {place_url}")
    return "\n".join(lines)


def openings_html(openings, place_url):
    items = "".join(f'<li><a href="{html.escape(o.url)}">{html.escape(o.label)}</a></li>'
                    for o in openings[:SITES_LISTED])
    if len(openings) > SITES_LISTED:
        items += f'<li><a href="{html.escape(place_url)}">{len(openings) - SITES_LISTED} more</a></li>'
    return f"<ul>{items}</ul>"


def alert_email(name, stay, openings):
    """(subject, text, html) saying sites are open for a watcher's whole stay."""
    place_url = SOURCES[stay.source].booking_url(stay.place)
    count = len(openings)
    lead = (f"{'A site is' if count == 1 else f'{count} sites are'} open at {name} "
            f"for your whole stay: {stay.dates()}.")
    text = "\n\n".join([
        lead,
        "Book fast; open sites usually go within minutes:\n" + openings_text(openings, place_url),
        f"Campground page: {place_url}",
        "You'll keep getting alerts for this stay until check-in.",
    ]) + "\n"
    body = html_page([
        f"<p><b>{html.escape(lead)}</b></p>",
        button(openings[0].url, "Book now"),
        "<p>Book fast; open sites usually go within minutes.</p>",
        openings_html(openings, place_url),
        f'<p><a href="{html.escape(place_url)}">Campground page</a></p>',
        small(f"Watching for {html.escape(stay.rig())}. You'll keep getting alerts for this stay until check-in."),
    ])
    return f"Campsite open: {name}, {stay.short_dates()}", text, body


def ended_email(name, problem):
    """(subject, text, html) telling a watcher their alert couldn't start."""
    text = f"{problem}\n\nYou can sign up again at {SIGNUP_PAGE} with the link from the campground's booking page.\n"
    body = html_page([f"<p>{html.escape(problem)}</p>",
                      f'<p><a href="{SIGNUP_PAGE}">Sign up again</a> with the link from the campground\'s booking page.</p>'])
    return f"Your CampSwoop alert for {name} couldn't start", text, body


# --- The CampSwoop API --------------------------------------------------------

class Api:
    """The Worker's /api/ endpoints: active watches in, emails out."""

    def __init__(self, token, dry_run=False):
        self.token, self.dry_run = token, dry_run

    def call(self, method, path, body=None):
        request = urllib.request.Request(
            f"{API_URL}{path}", method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
                     "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"{method} {path} answered {error.code}: {detail}") from error

    def watches(self):
        """{"watches": [...], "people", "pending", "emails_today"}; retries network errors."""
        for attempt in range(3):
            try:
                return self.call("GET", "/api/watches")
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                if attempt == 2:
                    raise
                print(f"Reading watches failed ({error}); retrying", file=sys.stderr)
                time.sleep(5 * (attempt + 1))

    def notify(self, watch_id, message):
        """Email the watcher. Not retried, so a failure can't send the same alert twice."""
        self.send("/api/notify", watch_id, message)

    def end(self, watch_id, message):
        """End the watch and email the watcher why."""
        self.send("/api/end", watch_id, message)

    def send(self, path, watch_id, message):
        subject, text, body = message
        if self.dry_run:
            print(f"--- Would call {path} for watch {watch_id}: {subject}\n{text}---")
            return
        self.call("POST", path, {"id": watch_id, "subject": subject, "text": text, "html": body})


# --- Checking -----------------------------------------------------------------

class Run:
    """One pass over every active watch."""

    def __init__(self, api, state, now):
        self.api, self.state, self.now = api, state, now
        self.errors = []
        self.checked = {}  # stay key -> openings (None if the check failed); watchers of a stay share it

    def place(self, link):
        """(source key, place) for a booking link, kept in state.json under a hash of the link."""
        places = self.state.setdefault("places", {})
        key = hashlib.sha256(link.encode()).hexdigest()[:16]
        if key not in places:
            for source_key, source in SOURCES.items():
                place = source.place_in(link)
                if place:
                    places[key] = f"{source_key}|{place}"
                    break
            else:
                raise ValueError("CampSwoop can't watch that booking site.")
        return places[key].split("|", 1)

    def stay(self, watch):
        source_key, place = self.place(watch["link"])
        source = SOURCES[source_key]
        camping, length = watch.get("camping") or "any", int(watch.get("length") or 0)
        if not source.filters_camping or camping not in CAMPING:
            camping, length = "any", 0
        stay = Stay(source_key, place, dt.date.fromisoformat(watch["check_in"]),
                    dt.date.fromisoformat(watch["check_out"]), camping, length)
        source.check_request(stay)
        return stay

    def name(self, stay, fallback):
        """The campground's name from its booking site, kept in state.json."""
        names = self.state.setdefault("names", {})
        key = f"{stay.source}|{stay.place}"
        if key not in names:
            try:
                names[key] = SOURCES[stay.source].name(stay.place)
            except Exception as error:
                print(f"::warning::Couldn't look up the name of {key}: {error}")
                return fallback
        return names[key]

    def openings(self, stay):
        if stay.key not in self.checked:
            try:
                self.checked[stay.key] = SOURCES[stay.source].openings(stay)
            except Exception as error:
                self.errors.append(f"checking {stay.key} failed: {error!r}")
                self.checked[stay.key] = None
        return self.checked[stay.key]

    def check(self, watch):
        try:
            stay = self.stay(watch)
        except (ValueError, NotFound) as problem:
            message = str(problem) if isinstance(problem, ValueError) else \
                "We couldn't find that campground on its booking site, so this alert has ended."
            self.api.end(watch["id"], ended_email(watch["name"], message))
            print(f"Ended watch {watch['id']}: {message}")
            return
        openings = self.openings(stay)
        if openings is None:
            return
        known = self.state.setdefault("watches", {}).setdefault(watch["id"], {})
        new = [o for o in openings if o.id not in set(known.get("open", []))]
        print(f"Watch {watch['id']} ({stay.key}): {len(openings)} open, {len(new)} new")
        if new:
            sent_on, sent = known.get("alerted", ["", 0])
            sent = sent if sent_on == self.now.isoformat() else 0
            if sent >= MAX_ALERTS_PER_WATCH_PER_DAY:
                print(f"::warning::Watch {watch['id']} already got {sent} alerts today; holding off")
            else:
                try:
                    self.api.notify(watch["id"], alert_email(self.name(stay, watch["name"]), stay, openings))
                except Exception as error:
                    self.errors.append(f"alerting watch {watch['id']} failed: {error}")
                    return  # leave "open" as it was, so the next check tries again
                known["alerted"] = [self.now.isoformat(), sent + 1]
        known["open"] = sorted(o.id for o in openings)

    def go(self):
        data = self.api.watches()
        watches = data.get("watches", [])
        for watch in watches:
            try:
                self.check(watch)
            except Exception as error:
                self.errors.append(f"watch {watch.get('id')} failed: {error!r}")
        # Forget watches that ended and campgrounds nobody watches any more.
        active = {watch["id"] for watch in watches}
        links = {hashlib.sha256(watch["link"].encode()).hexdigest()[:16] for watch in watches}
        self.state["watches"] = {watch_id: known for watch_id, known in self.state.get("watches", {}).items()
                                 if watch_id in active}
        self.state["places"] = {key: place for key, place in self.state.get("places", {}).items() if key in links}
        self.state["names"] = {key: name for key, name in self.state.get("names", {}).items()
                               if key in set(self.state["places"].values())}
        print(f"{len(watches)} active watch(es) for {data.get('people', 0)} people; "
              f"{data.get('pending', 0)} waiting to confirm; {data.get('emails_today', 0)} emails sent today")


# --- Main ---------------------------------------------------------------------

def check_one(link, check_in, check_out, camping, length):
    watch = {"id": "check", "link": link, "name": link, "check_in": check_in, "check_out": check_out,
             "camping": camping, "length": length}
    try:
        stay = Run(None, {}, today()).stay(watch)
        name = SOURCES[stay.source].name(stay.place)
    except ValueError as problem:
        sys.exit(str(problem))
    except NotFound:
        sys.exit("Couldn't find that campground.")
    openings = SOURCES[stay.source].openings(stay)
    print(f"{name}: {stay.dates()}, {stay.rig()}")
    print(f"{len(openings)} open for every night" + (":" if openings else ""))
    if openings:
        print(openings_text(openings, SOURCES[stay.source].booking_url(stay.place)))


def preview():
    stay = Stay("recgov", "232447", today() + dt.timedelta(days=60), today() + dt.timedelta(days=62))
    sample = [Opening("100", "Site 044 (Upper Pines)", "https://www.recreation.gov/camping/campsites/100"),
              Opening("150", "Site 123 (Upper Pines)", "https://www.recreation.gov/camping/campsites/150")]
    subject, text, _ = alert_email("Upper Pines Campground, CA", stay, sample)
    print(f"Subject: {subject}\n\n{text}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="check and print emails; send and change nothing")
    parser.add_argument("--check", nargs=3, metavar=("LINK", "CHECK_IN", "CHECK_OUT"),
                        help="print what's open for one stay")
    parser.add_argument("--camping", default="any", choices=sorted(CAMPING), help="with --check")
    parser.add_argument("--length", type=int, default=0, help="with --check: rig length in feet")
    parser.add_argument("--preview", action="store_true", help="print a sample alert email")
    args = parser.parse_args()

    if args.check:
        return check_one(*args.check, args.camping, args.length)
    if args.preview:
        return preview()

    token = os.environ.get("CAMPSWOOP_API_TOKEN", "").strip()
    if not token:
        sys.exit("Set CAMPSWOOP_API_TOKEN (the Worker's API_TOKEN secret).")
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    before = json.dumps(state, sort_keys=True)
    run = Run(Api(token, dry_run=args.dry_run), state, today())
    run.go()
    for error in run.errors:
        print(f"::warning::{error}")
    if not args.dry_run and json.dumps(state, sort_keys=True) != before:
        STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
        print(f"Updated {STATE_FILE.name}")
    # One campground failing isn't worth a failure email; every check failing is.
    if run.checked and all(openings is None for openings in run.checked.values()):
        sys.exit("Every availability check failed")


if __name__ == "__main__":
    main()
