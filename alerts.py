#!/usr/bin/env python3
"""CampSwoop: email people when a booked-up campground opens a site for their dates.

People sign up by emailing alerts@campswoop.com a booking link and their dates; the sign-up page in
docs/ (campswoop.com) writes that email for them. Cloudflare Email Routing forwards that address to
a Gmail account, which this script reads and sends from. Each run of this script:
  1. answers new emails: sign-ups, "stop" and "list";
  2. checks every active watch;
  3. emails everyone watching a stay when a site opens for every night of it.

Each active watch is a record message under the Gmail label "Watching", so the public repo never
holds anyone's address. state.json only keeps which sites were open at the last check, keyed by
campground and dates. Standard library only.

Usage:
  python alerts.py                # answer new emails, check every watch, send alerts
  python alerts.py --dry-run      # same, but send nothing and change nothing
  python alerts.py --check LINK CHECK_IN CHECK_OUT [--camping tent|trailer|motorhome|rv] [--length FT]
                                  # print what's open for one stay; needs no Gmail
  python alerts.py --test-email   # send a sample confirmation and alert to the alerts Gmail itself

Environment (repo secrets):
  GMAIL_ADDRESS         the Gmail account alerts@campswoop.com forwards to; never shown to anyone
  GMAIL_APP_PASSWORD    an App Password for that account
"""

import argparse
import datetime as dt
import email
import gzip
import html
import imaplib
import json
import os
import re
import secrets
import smtplib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from email import policy
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, parseaddr
from pathlib import Path

# --- Settings -----------------------------------------------------------------

SERVICE_NAME = "CampSwoop"
SIGNUP_PAGE = "https://campswoop.com/"
# People email this address; Cloudflare Email Routing forwards it to the Gmail account. Replies go here too.
PUBLIC_ADDRESS = "alerts@campswoop.com"

MAX_WATCHES_PER_PERSON = 3
MAX_WATCHES_TOTAL = 50
MAX_NIGHTS = 14
MAX_DAYS_AHEAD = 400
MAX_ALERTS_PER_STAY_PER_DAY = 6  # stops a flapping campground from flooding inboxes
SITES_LISTED = 6                 # open sites linked in one alert

# Gmail labels: one record message per active watch, and where answered emails and ended watches go.
WATCHING, HANDLED, ENDED = "Watching", "Handled", "Ended"

HERE = Path(__file__).parent
STATE_FILE = HERE / "state.json"
CACHE_DIR = HERE / ".cache"  # campsite details, reused between checks on the same runner
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")

CAMPING = {"any": "any site", "tent": "a tent", "trailer": "a trailer", "motorhome": "a motorhome or van",
           "rv": "an RV"}


def redact(text):
    """Hide email addresses; the run log of a public repo is public."""
    return re.sub(r"[\w.+-]+@[\w-]+(\.[\w-]+)+", "<email>", str(text))


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

    @classmethod
    def from_key(cls, key):
        source, place, check_in, check_out, camping, length = key.split(":")
        return cls(source, place, dt.date.fromisoformat(check_in), dt.date.fromisoformat(check_out),
                   camping, int(length))

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
        """Raise ValueError, with a message for the sender, if this stay can't be watched here."""


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


# --- Reading emails -----------------------------------------------------------

MONTH_NAMES = "jan feb mar apr may jun jul aug sep oct nov dec".split()
MONTH = (r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?"
         r"|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?")
DAY = r"(\d{1,2})(?:st|nd|rd|th)?"
DATES = re.compile("|".join([
    r"\b(?P<iso>(\d{4})-(\d{1,2})-(\d{1,2}))\b",
    rf"\b(?P<range>{MONTH}\s+{DAY}\s*(?:-|–|—|to|through|thru)\s*(?:{MONTH}\s+)?{DAY}(?:,?\s+(\d{{4}}))?)\b",
    rf"\b(?P<named>{MONTH}\s+{DAY}(?:,?\s+(\d{{4}}))?)\b",
    r"\b(?P<us>(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?)\b",
]), re.I)
URL = re.compile(r"https?://[^\s<>\"')\]]+", re.I)


def resolve(year, month, day, now):
    """A date; without a year, the next time that month and day comes around."""
    if year:
        year = int(year)
        return dt.date(year + 2000 if year < 100 else year, month, day)
    date = dt.date(now.year, month, day)
    return date if date >= now else dt.date(now.year + 1, month, day)


def find_dates(text, now):
    """Every date in the text, in order; "Jun 12-14" gives two."""
    found = []
    for match in DATES.finditer(URL.sub(" ", text)):
        groups = match.groups()
        try:
            if match["iso"]:
                found.append(dt.date(int(groups[1]), int(groups[2]), int(groups[3])))
            elif match["range"]:
                month1, day1, month2, day2, year = groups[5:10]
                start_month = MONTH_NAMES.index(month1[:3].lower()) + 1
                end_month = MONTH_NAMES.index(month2[:3].lower()) + 1 if month2 else start_month
                wraps = end_month < start_month  # e.g. Dec 30 – Jan 2; a written year belongs to the end
                if year:
                    end = resolve(year, end_month, int(day2), now)
                    start = dt.date(end.year - wraps, start_month, int(day1))
                else:
                    start = resolve(None, start_month, int(day1), now)
                    end = dt.date(start.year + wraps, end_month, int(day2))
                found += [start, end]
            elif match["named"]:
                month, day, year = groups[11:14]
                found.append(resolve(year, MONTH_NAMES.index(month[:3].lower()) + 1, int(day), now))
            else:
                month, day, year = groups[15:18]
                found.append(resolve(year, int(month), int(day), now))
        except ValueError:  # e.g. Feb 30
            continue
    return found


def find_camping(text):
    """(camping key, length ft) from a "Camping in:" line, or from the whole text without one."""
    line = re.search(r"^\s*camping in:\s*(.+)$", text, re.I | re.M)
    scope = line.group(1) if line else "\n".join(
        l for l in URL.sub(" ", text).splitlines() if not re.match(r"\s*campground:", l, re.I))
    length = re.search(r"\b(\d{1,2})\s*(?:ft|feet|foot|'|-foot)", scope, re.I)
    length = int(length.group(1)) if length else 0
    if re.search(r"motor ?home|class [abc]\b|camper ?van|\bvan\b", scope, re.I):
        return "motorhome", length
    if re.search(r"trailer|fifth wheel|5th wheel|pop-? ?up|toy hauler", scope, re.I):
        return "trailer", length
    if re.search(r"\brv\b|\bcamper\b", scope, re.I):
        return "rv", length
    if re.search(r"\btents?\b", scope, re.I):
        return "tent", 0
    return "any", 0


def visible_text(message):
    """What the sender wrote in this email: plain text (or HTML as text), minus any quoted reply."""
    part = message.get_body(preferencelist=("plain", "html"))
    try:
        text = part.get_content() if part else ""
    except (LookupError, ValueError):
        text = ""
    if part and part.get_content_type() == "text/html":
        text = html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(style|script).*?</\1>|<br\s*/?>|</p>", "\n", text)))
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"\s*(>|-+\s*Original Message|_{5,}|From:\s)", line, re.I) or \
                re.match(r"\s*On\s", line) and "wrote:" in " ".join(lines[i:i + 3]):
            lines = lines[:i]
            break
    return "\n".join(lines).strip()


def full_text(message):
    part = message.get_body(preferencelist=("plain", "html"))
    try:
        return part.get_content() if part else ""
    except (LookupError, ValueError):
        return ""


def subject_of(message):
    return re.sub(r"^\s*((re|fwd?|aw|sv)\s*:\s*)+", "", str(message.get("Subject", "")), flags=re.I).strip()


def verified_sender(message):
    """The From address, if Gmail confirmed it wasn't forged; otherwise None."""
    address = parseaddr(str(message.get("From", "")))[1].strip().lower()
    if "@" not in address:
        return None
    domain = re.escape(address.rsplit("@", 1)[1])
    # Gmail adds its verdict as the topmost Authentication-Results header; anything below could be forged.
    results = str((message.get_all("Authentication-Results") or [""])[0])
    if "mx.google.com" not in results:
        return None
    if re.search(rf"\bdmarc=pass\b[^;]*header\.from={domain}\b", results, re.I) or \
            re.search(rf"\bdkim=pass header\.i=@?([\w-]+\.)*{domain}\b", results, re.I) or \
            re.search(rf"\bspf=pass\b.*smtp\.mailfrom=(\S*@)?([\w-]+\.)*{domain}\b", results, re.I):
        return address
    return None


def automated(message, address):
    """True for bounces, vacation replies and mailing lists, which must never get a reply."""
    return (str(message.get("Auto-Submitted", "no")).lower() != "no"
            or str(message.get("Precedence", "")).lower() in ("bulk", "junk", "list")
            or bool(message.get("List-Id") or message.get("List-Unsubscribe"))
            or bool(re.match(r"(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)\b", address)))


# --- Watches ------------------------------------------------------------------

@dataclass
class Watch:
    email: str
    stay: Stay
    name: str         # campground's display name
    code: str         # short id people use to stop just this watch, e.g. "7K3PQ"
    created: str
    uid: bytes = b""  # IMAP UID of its record under the Watching label

    def record(self, sender):
        """The message stored under the Watching label; readable in Gmail, parsed back by from_record."""
        message = EmailMessage()
        message["Subject"] = f"{self.name} · {self.stay.short_dates()} {self.stay.check_out.year} · {self.email}"
        message["From"] = formataddr((SERVICE_NAME, sender))
        message["To"] = self.email
        message["Date"] = email.utils.formatdate(localtime=True)
        message.set_content(json.dumps({"email": self.email, "stay": self.stay.key, "name": self.name,
                                        "code": self.code, "created": self.created}, indent=2) + "\n")
        return message.as_bytes()

    @classmethod
    def from_record(cls, uid, message):
        data = json.loads(full_text(message))
        return cls(data["email"], Stay.from_key(data["stay"]), data["name"], data["code"], data["created"], uid)

    def title(self):
        return f"{self.name}, {self.stay.short_dates()}"


def stop_link(code=None):
    subject = f"Stop #{code}" if code else "Stop all"
    return f"mailto:{PUBLIC_ADDRESS}?" + urllib.parse.urlencode({"subject": subject, "body": subject},
                                                                quote_via=urllib.parse.quote)


# --- Email in and out ---------------------------------------------------------

class Mailbox:
    """The alerts Gmail account over IMAP (reading) and SMTP (sending)."""

    def __init__(self, address, password, dry_run=False):
        self.address, self.password, self.dry_run = address, password, dry_run
        self.imap = imaplib.IMAP4_SSL("imap.gmail.com")
        self.imap.login(address, password)
        self.smtp = None
        if not dry_run:
            for label in (WATCHING, HANDLED, ENDED):
                self.imap.create(label)  # answers NO if the label already exists, which is fine

    def close(self):
        try:
            self.imap.logout()
        finally:
            if self.smtp:
                self.smtp.quit()

    def folder_with(self, attribute):
        """Name of the folder carrying a special-use attribute, e.g. \\Junk for Gmail's Spam."""
        for line in self.imap.list()[1]:
            line = line.decode()
            if attribute in line.split(")")[0]:
                return line.rsplit(' "/" ', 1)[1]
        return None

    def messages(self, folder, search="ALL"):
        """[(uid, message)] in a folder, oldest first, without marking anything read."""
        if self.imap.select(folder, readonly=self.dry_run)[0] != "OK":
            return []
        uids = self.imap.uid("SEARCH", None, search)[1][0].split()
        found = []
        for start in range(0, len(uids), 50):
            data = self.imap.uid("FETCH", b",".join(uids[start:start + 50]).decode(), "(UID BODY.PEEK[])")[1]
            for item in data:
                if isinstance(item, tuple):
                    uid = re.search(rb"UID (\d+)", item[0]).group(1)
                    found.append((uid, email.message_from_bytes(item[1], policy=policy.default)))
        return sorted(found, key=lambda pair: int(pair[0]))

    def move(self, folder, uid, destination):
        if self.dry_run:
            return
        self.imap.select(folder)
        self.imap.uid("MOVE", uid.decode(), destination)

    def rescue_spam(self):
        """Move sign-up emails Gmail filed as spam back to the inbox."""
        spam = self.folder_with("\\Junk")
        if not spam:
            return
        for uid, message in self.messages(spam):
            if verified_sender(message) and re.match(r"(watch|stop|list)\b", subject_of(message), re.I):
                print("Moved a sign-up email out of spam")
                self.move(spam, uid, "INBOX")

    def watches(self):
        watches = []
        for uid, message in self.messages(WATCHING):
            try:
                watches.append(Watch.from_record(uid, message))
            except (ValueError, KeyError) as error:
                print(f"::warning::Skipping a Watching record that doesn't parse ({redact(error)})")
        return watches

    def add_watch(self, watch):
        if self.dry_run:
            return
        self.imap.append(WATCHING, None, imaplib.Time2Internaldate(time.time()), watch.record(self.address))

    def end_watch(self, watch):
        if watch.uid:
            self.move(WATCHING, watch.uid, ENDED)

    def send(self, to, subject, text, html_body=None, reply_to_message=None):
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = formataddr((SERVICE_NAME, self.address))
        message["To"] = to
        message["Reply-To"] = PUBLIC_ADDRESS
        message["Message-ID"] = make_msgid(domain="campswoop.com")
        message["Auto-Submitted"] = "auto-replied" if reply_to_message else "auto-generated"
        if reply_to_message is not None and reply_to_message.get("Message-ID"):
            original = str(reply_to_message["Message-ID"])
            message["In-Reply-To"] = original
            message["References"] = f"{reply_to_message.get('References', '')} {original}".strip()
        message.set_content(text)
        if html_body:
            message.add_alternative(html_body, subtype="html")
        if self.dry_run:
            print(f"--- Would email {to}: {subject}\n{text}\n---")
            return
        if self.smtp is None:
            self.smtp = smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30)
            self.smtp.login(self.address, self.password)
        self.smtp.send_message(message)


# --- Email text ---------------------------------------------------------------

def html_page(paragraphs):
    """A plain, phone-friendly HTML email from already-escaped HTML paragraphs."""
    body = "".join(paragraphs)
    return (f'<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
            f'font-size:16px;line-height:1.5;color:#1d2a20;max-width:560px">{body}</div>')


def button(url, label):
    return (f'<p><a href="{html.escape(url)}" style="display:inline-block;background:#2f6b3a;color:#fff;'
            f'text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">{html.escape(label)}</a></p>')


def small(text_html):
    return f'<p style="font-size:13px;color:#5b6b5e">{text_html}</p>'


def openings_text(openings, place_url):
    lines = [f"  {opening.label}: {opening.url}" for opening in openings[:SITES_LISTED]]
    if len(openings) > SITES_LISTED:
        lines.append(f"  …and {len(openings) - SITES_LISTED} more: {place_url}")
    return "\n".join(lines)


def openings_html(openings, place_url):
    items = "".join(f'<li><a href="{html.escape(o.url)}">{html.escape(o.label)}</a></li>'
                    for o in openings[:SITES_LISTED])
    if len(openings) > SITES_LISTED:
        items += f'<li><a href="{html.escape(place_url)}">{len(openings) - SITES_LISTED} more</a></li>'
    return f"<ul>{items}</ul>"


def alert_email(watch, openings):
    source = SOURCES[watch.stay.source]
    place_url = source.booking_url(watch.stay.place)
    subject = f"Campsite open: {watch.title()}"
    count = len(openings)
    lead = (f"{'A site is' if count == 1 else f'{count} sites are'} open at {watch.name} "
            f"for your whole stay: {watch.stay.dates()}.")
    text = "\n\n".join([
        lead,
        "Book fast; cancellations usually go within minutes:\n" + openings_text(openings, place_url),
        f"Campground page: {place_url}",
        f"You'll keep getting alerts for this stay until check-in. Reply \"stop\" to end them (watch #{watch.code}).",
    ]) + "\n"
    body = html_page([
        f"<p><b>{html.escape(lead)}</b></p>",
        button(openings[0].url, "Book now"),
        "<p>Book fast; cancellations usually go within minutes.</p>",
        openings_html(openings, place_url),
        f'<p><a href="{html.escape(place_url)}">Campground page</a></p>',
        small(f"Watching for {html.escape(watch.stay.rig())}. You'll keep getting alerts for this stay until "
              f'check-in. <a href="{html.escape(stop_link(watch.code))}">Stop these alerts</a> '
              f"(watch #{watch.code})."),
    ])
    return subject, text, body


def confirmation_email(watch, openings):
    source = SOURCES[watch.stay.source]
    place_url = source.booking_url(watch.stay.place)
    facts = [f"Campground: {watch.name} ({source.site_name(watch.stay.place)})",
             f"Stay: {watch.stay.dates()}",
             f"Camping in: {watch.stay.rig()}"]
    if openings:
        status = (f"Good news: {'a site is' if len(openings) == 1 else f'{len(openings)} sites are'} "
                  "open for every night right now. Book now:")
    else:
        status = ("Right now no site is free for every night of your stay. We check every 5 minutes and "
                  "will email you as soon as one is.")
    text = "\n\n".join(filter(None, [
        "You're signed up. " + status,
        openings_text(openings, place_url) if openings else "",
        "\n".join(facts),
        f"Wrong dates or campground? Reply \"stop\", then sign up again at {SIGNUP_PAGE}",
        f"Reply \"stop\" anytime to end alerts for this stay (watch #{watch.code}), or \"list\" to see your watches.",
    ])) + "\n"
    body = html_page(list(filter(None, [
        f"<p><b>You're signed up.</b> {html.escape(status)}</p>",
        openings_html(openings, place_url) if openings else "",
        "<p>" + "<br>".join(html.escape(fact) for fact in facts) + "</p>",
        f'<p><a href="{html.escape(place_url)}">Campground page</a></p>',
        small(f'Wrong dates or campground? <a href="{html.escape(stop_link(watch.code))}">Stop this '
              f'watch</a>, then <a href="{SIGNUP_PAGE}">sign up again</a>. Reply "list" to see your watches '
              f"(this one is #{watch.code})."),
    ])))
    return text, body


def list_email(watches):
    if not watches:
        text = f"You're not watching any campgrounds. Sign up at {SIGNUP_PAGE}\n"
        return text, html_page([f'<p>You\'re not watching any campgrounds. <a href="{SIGNUP_PAGE}">Sign up</a>.</p>'])
    lines = [f"#{w.code}  {w.name}: {w.stay.dates()}, {w.stay.rig()}" for w in watches]
    text = "Your watches:\n\n" + "\n".join(lines) + "\n\nTo end one, reply \"stop\" and its code, e.g. " \
           f"\"stop #{watches[0].code}\". Reply \"stop all\" to end them all.\n"
    items = "".join(f'<li>{html.escape(w.name)}: {html.escape(w.stay.dates())}, {html.escape(w.stay.rig())} '
                    f'(<a href="{html.escape(stop_link(w.code))}">stop</a>)</li>' for w in watches)
    return text, html_page(["<p>Your watches:</p>", f"<ul>{items}</ul>",
                            small(f'<a href="{html.escape(stop_link())}">Stop all</a>')])


def help_email(problem):
    supported = ", ".join(source.title for source in SOURCES.values())
    text = "\n\n".join([
        problem,
        f"The easiest way to sign up is the form at {SIGNUP_PAGE}",
        f"Or email {PUBLIC_ADDRESS} a campground's booking link and your check-in and check-out dates, e.g.\n"
        "  https://www.recreation.gov/camping/campgrounds/232447\n  Check in: 2027-06-12\n  Check out: 2027-06-14",
        f"Booking sites we can watch: {supported}.",
    ]) + "\n"
    return text, html_page([f"<p>{html.escape(problem)}</p>",
                            f'<p>The easiest way to sign up is the <a href="{SIGNUP_PAGE}">sign-up page</a>.</p>',
                            small(f"Booking sites we can watch: {html.escape(supported)}.")])


# --- Handling emails ----------------------------------------------------------

def parse_request(text, now):
    """(Stay, name) from a sign-up email, or raise ValueError with a message for the sender."""
    for key, source in SOURCES.items():
        try:
            place = source.place_in(text)
        except NotFound:
            raise ValueError("That link doesn't point to a campground we could find.")
        if place:
            break
    else:
        links = [urllib.parse.urlparse(url).hostname or "" for url in URL.findall(text)]
        links = [host.removeprefix("www.") for host in links if host]
        if links:
            raise ValueError(f"We can't watch {links[0]} yet.")
        raise ValueError("We couldn't find a campground booking link in your email.")
    dates = list(dict.fromkeys(find_dates(text, now)))
    if not dates:
        raise ValueError("We couldn't find your check-in and check-out dates.")
    check_in = min(dates[:2])
    check_out = max(dates[:2]) if len(dates) > 1 else check_in + dt.timedelta(days=1)
    if check_in < now:
        raise ValueError(f"Your check-in date, {day_name(check_in)}, {check_in.year}, has already passed.")
    if (check_out - check_in).days > MAX_NIGHTS:
        raise ValueError(f"We can watch stays of up to {MAX_NIGHTS} nights.")
    if (check_in - now).days > MAX_DAYS_AHEAD:
        raise ValueError("We can watch dates up to about a year ahead.")
    camping, length = find_camping(text) if source.filters_camping else ("any", 0)
    try:
        name = source.name(place)
    except NotFound:
        raise ValueError("That link doesn't point to a campground we could find.")
    stay = Stay(key, place, check_in, check_out, camping, length)
    source.check_request(stay)
    return stay, name


class Run:
    """One pass: answer new emails, check every watch, send alerts."""

    def __init__(self, mailbox, state, now):
        self.mailbox, self.state, self.now = mailbox, state, now
        self.watches = []
        self.errors = []

    def openings(self, stay):
        """What's open for a stay now, or None if the booking site couldn't be checked."""
        try:
            return SOURCES[stay.source].openings(stay)
        except Exception as error:
            self.errors.append(f"checking {stay.key} failed: {error}")
            return None

    def remember(self, stay, openings):
        self.state.setdefault("stays", {}).setdefault(stay.key, {})["open"] = sorted(o.id for o in openings)

    def handle(self, message):
        """Answer one email from the inbox."""
        sender = verified_sender(message)
        if not sender or sender in (self.mailbox.address.lower(), PUBLIC_ADDRESS) or automated(message, sender):
            return
        subject, text = subject_of(message), visible_text(message)
        words = (subject + " " + text).split()
        first = {re.sub(r"\W", "", word).lower() for word in (subject.split()[:1] + text.split()[:1])}
        mine = [w for w in self.watches if w.email == sender]

        if first & {"stop", "unsubscribe", "cancel", "remove", "end"}:
            codes = set(re.findall(r"#([A-Z2-9]{5})\b", subject + " " + text, re.I)) or \
                    set(re.findall(r"#([A-Z2-9]{5})\b", full_text(message), re.I))
            codes = {code.upper() for code in codes}
            everything = "all" in {w.lower().strip(".!") for w in words[:4]} or not codes
            ending = [w for w in mine if everything or w.code in codes]
            for watch in ending:
                self.mailbox.end_watch(watch)
                self.watches.remove(watch)
            done = "\n".join(f"  {w.name}: {w.stay.dates()}" for w in ending)
            text = (f"Stopped. No more alerts for:\n{done}\n" if ending
                    else "You had no watches matching that, so nothing changed.\n")
            text += f"\nSign up again anytime at {SIGNUP_PAGE}\n"
            self.mailbox.send(sender, "Re: " + (subject or "Stop"), text, reply_to_message=message)
            print(f"Stopped {len(ending)} watch(es)")
            return

        if first & {"list", "status", "watches"}:
            text, body = list_email(mine)
            self.mailbox.send(sender, "Re: " + (subject or "Your watches"), text, body, reply_to_message=message)
            return

        is_reply = bool(message.get("In-Reply-To")) or bool(re.match(r"\s*re\s*:", str(message.get("Subject", "")), re.I))
        try:
            # The body first: its "Check in:" lines are exact, while a subject may abbreviate the dates.
            stay, name = parse_request(f"{text}\n{subject}", self.now)
        except ValueError as problem:
            if is_reply and not URL.search(text):
                return  # e.g. "thanks!" in reply to an alert; nothing to answer
            host = re.match(r"We can't watch (\S+) yet", str(problem))
            if host:
                requested = self.state.setdefault("requested_sites", {})
                requested[host.group(1)] = requested.get(host.group(1), 0) + 1
            text, body = help_email(str(problem))
            self.mailbox.send(sender, "Re: " + (subject or SERVICE_NAME), text, body, reply_to_message=message)
            print(f"Couldn't read a sign-up: {redact(problem)}")
            return

        reply = "Re: " + (subject or f"Watch {name}")
        if any(w.stay == stay for w in mine):
            self.mailbox.send(sender, reply, f"You're already watching {name} for {stay.dates()}.\n",
                              reply_to_message=message)
            return
        if len(mine) >= MAX_WATCHES_PER_PERSON:
            text, body = list_email(mine)
            self.mailbox.send(sender, reply, f"You can watch up to {MAX_WATCHES_PER_PERSON} stays at a time. "
                              "Stop one, then sign up again.\n\n" + text, body, reply_to_message=message)
            return
        if len(self.watches) >= MAX_WATCHES_TOTAL:
            self.mailbox.send(sender, reply, f"Sorry, {SERVICE_NAME} is full right now. Try again in a few days.\n",
                              reply_to_message=message)
            print("::warning::Turned away a sign-up: the watch limit is reached")
            return
        code = ""
        while not code or code in {w.code for w in self.watches}:
            code = "".join(secrets.choice("ABCDEFGHJKMNPQRSTUVWXYZ23456789") for _ in range(5))
        watch = Watch(sender, stay, name, code, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"))
        openings = self.openings(stay) or []
        self.mailbox.add_watch(watch)
        self.watches.append(watch)
        self.remember(stay, openings)
        text, body = confirmation_email(watch, openings)
        self.mailbox.send(sender, reply, text, body, reply_to_message=message)
        print(f"New watch: {SOURCES[stay.source].title} {stay.key}")

    def answer_emails(self):
        self.mailbox.rescue_spam()
        for uid, message in self.mailbox.messages("INBOX"):
            try:
                self.handle(message)
            except Exception as error:
                self.errors.append(f"handling an email failed: {error!r}")
                try:
                    sent = email.utils.parsedate_to_datetime(str(message["Date"]))
                    fresh = dt.datetime.now(dt.timezone.utc) - sent < dt.timedelta(days=1)
                except (TypeError, ValueError):
                    fresh = False
                if fresh:
                    continue  # leave it in the inbox and try again next check (e.g. the booking site was down)
            self.mailbox.move("INBOX", uid, HANDLED)

    def end_past_watches(self):
        for watch in [w for w in self.watches if w.stay.check_in < self.now]:
            self.mailbox.end_watch(watch)
            self.watches.remove(watch)
            print(f"Ended a watch whose check-in has passed: {watch.stay.key}")

    def check(self):
        stays = {w.stay for w in self.watches}
        for stay in sorted(stays, key=lambda s: s.key):
            openings = self.openings(stay)
            if openings is None:
                continue
            known = self.state.get("stays", {}).get(stay.key, {})
            new = [o for o in openings if o.id not in set(known.get("open", []))]
            print(f"{stay.key}: {len(openings)} open, {len(new)} new")
            if new:
                sent_on, sent = known.get("alerted", ["", 0])
                sent = sent if sent_on == self.now.isoformat() else 0
                if sent < MAX_ALERTS_PER_STAY_PER_DAY:
                    for watch in [w for w in self.watches if w.stay == stay]:
                        subject, text, body = alert_email(watch, openings)
                        try:
                            self.mailbox.send(watch.email, subject, text, body)
                        except Exception as error:
                            self.errors.append(f"alert email failed: {error!r}")
                    known["alerted"] = [self.now.isoformat(), sent + 1]
                else:
                    print(f"::warning::{stay.key} already alerted {sent} times today; holding off")
            known["open"] = sorted(o.id for o in openings)
            self.state.setdefault("stays", {})[stay.key] = known
        # Forget stays nobody watches any more.
        self.state["stays"] = {key: value for key, value in self.state.get("stays", {}).items()
                               if key in {s.key for s in stays}}

    def go(self):
        self.watches = self.mailbox.watches()
        self.answer_emails()
        self.end_past_watches()
        self.check()
        print(f"{len(self.watches)} active watch(es), {len({w.email for w in self.watches})} people")


# --- Main ---------------------------------------------------------------------

def credentials():
    address = os.environ.get("GMAIL_ADDRESS", "").strip()
    password = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not address or not password:
        sys.exit("Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD (the alerts Gmail account and its App Password).")
    return address, password


def check_one(link, check_in, check_out, camping, length):
    now = today()
    try:
        stay, name = parse_request(f"{link}\nCheck in: {check_in}\nCheck out: {check_out}\n"
                                   f"Camping in: {camping} {length or ''} ft", now)
    except ValueError as problem:
        sys.exit(str(problem))
    openings = SOURCES[stay.source].openings(stay)
    print(f"{name}: {stay.dates()}, {stay.rig()}")
    print(f"{len(openings)} open for every night" + (":" if openings else ""))
    if openings:
        print(openings_text(openings, SOURCES[stay.source].booking_url(stay.place)))


def test_email():
    address, password = credentials()
    mailbox = Mailbox(address, password)
    stay = Stay("recgov", "232447", today() + dt.timedelta(days=60), today() + dt.timedelta(days=62))
    watch = Watch(address, stay, "Upper Pines Campground, CA (sample)", "TEST1", "")
    sample = [Opening("100", "Site 044 (Upper Pines)", "https://www.recreation.gov/camping/campsites/100")]
    text, body = confirmation_email(watch, [])
    mailbox.send(address, "Sample: sign-up confirmation", text, body)
    subject, text, body = alert_email(watch, sample)
    mailbox.send(address, "Sample: " + subject, text, body)
    mailbox.close()
    print(f"Sent a sample confirmation and alert to {address}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="read and check, but send and change nothing")
    parser.add_argument("--check", nargs=3, metavar=("LINK", "CHECK_IN", "CHECK_OUT"),
                        help="print what's open for one stay")
    parser.add_argument("--camping", default="any", choices=sorted(CAMPING), help="with --check")
    parser.add_argument("--length", type=int, default=0, help="with --check: rig length in feet")
    parser.add_argument("--test-email", action="store_true", help="email a sample confirmation and alert to the alerts Gmail")
    args = parser.parse_args()

    if args.check:
        return check_one(*args.check, args.camping, args.length)
    if args.test_email:
        return test_email()

    address, password = credentials()
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    before = json.dumps(state, sort_keys=True)
    mailbox = Mailbox(address, password, dry_run=args.dry_run)
    run = Run(mailbox, state, today())
    try:
        run.go()
    finally:
        mailbox.close()
    for error in run.errors:
        print(f"::warning::{redact(error)}")
    if not args.dry_run and json.dumps(state, sort_keys=True) != before:
        STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
        print(f"Updated {STATE_FILE.name}")
    # A failed check of one campground isn't worth a failure email; a run where nothing worked is.
    checked = {w.stay for w in run.watches}
    if checked and len([e for e in run.errors if e.startswith("checking")]) >= len(checked):
        sys.exit("Every availability check failed")


if __name__ == "__main__":
    main()
