#!/usr/bin/env python3
"""Build docs/data/campgrounds.json: every campground CampSwoop can watch, for the "Explore the map" tab.

Sources (public, no keys):
  r        Recreation.gov search API: reservable campgrounds that have overnight sites (alerts.py only
           watches overnight sites, so day-use-only shelters and picnic areas are left out).
  w b o p  Camis (GoingToCamp) /api/resourceLocation for Washington State Parks, BC Parks, Ontario Parks
           and Parks Canada: locations with a booking map and something to stay the night in (locations
           that only sell day use, parking, shuttles, guided hikes, rentals or moorage are left out).
  f        Firefly Reservations: properties are listed by hand in FIREFLY.

Camis has coordinates for few parks outside Washington, so the rest are geocoded by name with Photon
(photon.komoot.io, OpenStreetMap data): first the park, then the named campground inside that park,
limited to the park system's region and checked by country, province and name. Photon is asked about
once a second, and every answer is kept in tools/geocode_cache.json so re-runs only query new names
(delete an entry to redo it).

Output: {"generated": "YYYY-MM-DD", "systems": {code: title},
         "places": [[system, lng, lat, name, area, ref], ...]}
  lng/lat are WGS84 degrees rounded to 4 decimals, longitude first (GeoJSON order).
  ref is the Recreation.gov facility id, Camis "resourceLocationId|rootMapId", or the Firefly slug.
  Compact JSON with one place per line, sorted by system, name and ref, so diffs stay readable.

Usage: python tools/build_map_data.py      (Python 3.12, standard library only)
"""

import datetime as dt
import gzip
import json
import math
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "docs" / "data" / "campgrounds.json"
CACHE = HERE / "geocode_cache.json"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")

SYSTEMS = {"r": "Recreation.gov", "w": "Washington State Parks", "b": "BC Parks", "o": "Ontario Parks",
           "p": "Parks Canada", "f": "Firefly Reservations"}

RECGOV_SEARCH = ("https://www.recreation.gov/api/search?fq=entity_type%3Acampground&fq=reservable%3A1"
                 "&size=500&start={start}")

# Camis park systems: host, area label, region box (min lng, min lat, max lng, max lat), and what Photon
# must say about a geocoded place (country code, and state or province when the system has just one).
CAMIS = {
    "w": {"host": "washington.goingtocamp.com", "area": "Washington", "box": (-124.9, 45.5, -116.9, 49.1),
          "country": "US", "state": "Washington"},
    "b": {"host": "camping.bcparks.ca", "area": "British Columbia", "box": (-139.1, 48.2, -114.0, 60.1),
          "country": "CA", "state": "British Columbia"},
    "o": {"host": "reservations.ontarioparks.ca", "area": "Ontario", "box": (-95.2, 41.6, -74.3, 56.9),
          "country": "CA", "state": "Ontario"},
    "p": {"host": "reservation.pc.gc.ca", "area": "Canada", "box": (-141.1, 41.6, -52.6, 83.2),
          "country": "CA", "state": None},
}

# Camis resource categories that are not somewhere to stay the night. A location is left out when all of
# its categories are in this list; categories not listed here (new ones included) count as overnight.
NOT_OVERNIGHT = {name.casefold() for name in (
    "Day Use Facility", "Day Use Facility - Kopachuck Hall", "Conference Day-Use Facility",
    "Retreat Center Day Use", "Retreat Center - Add-ons DayUse", "Group Picnic Area", "Guided Hike",
    "Guided Event", "Learn-to Activity", "Day Runner Hike", "Daily Fishing", "Ice Fishing",
    "Parking", "Pay & Display Parking", "Daily Vehicle Permit (DVP)", "In Park DVP", "InPark DVP",
    "Bus Permit", "In Park Bus Permit", "Shuttle", "Day Use Bus", "Ferry",
    "Marina", "Annual Marina", "Mooring Buoy", "Boat Slip", "Trailer/Boat Storage",
    "Camping Supplies", "Deposit", "Canoe", "Kayak", "Single Kayak", "Double Kayak", "SUP", "Boat",
    "Paddle Boat", "Pedal Boat", "Water Accessories", "Royalex", "Aluminum", "Kevlar", "Inflatable",
    "Bicycle", "eBike", "Winter Bike", "Helmet", "Snowshoes", "Ice Skates", "Kick Sled", "XC Ski",
    "1 XC Classic", "2 XC Skate", "3 Boots", "4 Poles", "5 Skis", "Other Winter Rental", "Sports", "Games",
    "15 AMP", "30 AMP", "Extension Cord", "Adapter")}

# Parks Canada names look like "Park - Site". Park part -> official park name (the area label, and the
# first thing geocoded). Parts that aren't parks themselves only get an area label.
PC_PARKS = {
    "Banff": "Banff National Park", "Jasper": "Jasper National Park", "Kootenay": "Kootenay National Park",
    "Yoho": "Yoho National Park", "Glacier": "Glacier National Park",
    "Mount Revelstoke": "Mount Revelstoke National Park", "Waterton Lakes": "Waterton Lakes National Park",
    "Elk Island": "Elk Island National Park", "Wood Buffalo": "Wood Buffalo National Park",
    "Kluane": "Kluane National Park and Reserve", "Pacific Rim": "Pacific Rim National Park Reserve",
    "Gulf Islands": "Gulf Islands National Park Reserve", "Grasslands": "Grasslands National Park",
    "Prince Albert": "Prince Albert National Park", "Riding Mountain": "Riding Mountain National Park",
    "Pukaskwa": "Pukaskwa National Park", "Bruce Peninsula": "Bruce Peninsula National Park",
    "Fathom Five": "Fathom Five National Marine Park", "Point Pelee": "Point Pelee National Park",
    "Georgian Bay Islands": "Georgian Bay Islands National Park",
    "Thousand Islands": "Thousand Islands National Park", "La Mauricie": "La Mauricie National Park",
    "Forillon": "Forillon National Park", "Mingan Archipelago": "Mingan Archipelago National Park Reserve",
    "Fundy": "Fundy National Park", "Kouchibouguac": "Kouchibouguac National Park",
    "Kejimkujik": "Kejimkujik National Park", "Cape Breton Highlands": "Cape Breton Highlands National Park",
    "Prince Edward Island": "Prince Edward Island National Park", "Gros Morne": "Gros Morne National Park",
    "Terra Nova": "Terra Nova National Park",
}
PC_AREAS = {**PC_PARKS, "Lake Louise": "Banff National Park", "Icefields Parkway": "Banff National Park",
            "Banff, Kootenay and Yoho": "Banff, Kootenay and Yoho National Parks"}

# The site part of "Park - Site" names that doesn't name a place: these are put at the park.
GENERIC_SITES = {"backcountry", "backcountry camping", "overflow", "campground area", "canoe-camping",
                 "soft/hard-sided"}

# Names the general rules can't geocode: name -> queries to try instead, best first (the first query
# with an acceptable answer wins).
GEOCODE_AS = {
    "Fort Worden Campus Operations": ["Fort Worden State Park"],
    "Retreat Center - Camp Moran": ["Moran State Park"],  # OpenStreetMap has no Camp Moran
    "Okanagan Lake North Provincial Park": ["Okanagan Lake Provincial Park North Campground",
                                            "Okanagan Lake Provincial Park"],
    "Tweedsmuir Provincial Park – South": ["Tweedsmuir South Provincial Park", "Tweedsmuir Provincial Park"],
    "Spanish River & Biscotasi Lake Provincial Parks": ["Spanish River Provincial Park",
                                                        "Biscotasi Lake Provincial Park"],
    "Temagami (Lady Evelyn-Smoothwater, Obabika River, Sturgeon River, Solace, Makobe-Grays River)":
        ["Lady Evelyn-Smoothwater Provincial Park", "Lady Evelyn-Smoothwater"],
    "Wabakimi Provincial Park": ["Wabakimi Provincial Park", "Wabakimi Lake"],
    "Banff, Kootenay and Yoho - Backcountry": ["Banff National Park"],
}
# A "Park - Site" whose site is just a direction ("Kouchibouguac - South") only matches a campground.
DIRECTIONS = {"north", "south", "east", "west"}

# Each Camis location names its time zone; a geocoded place must also be inside that zone's rough box
# (min lng, min lat, max lng, max lat), which keeps "Lake Louise" in Alberta and out of Ontario.
TIME_ZONE_BOXES = {
    "America/St_Johns": (-59.7, 46.4, -52.5, 52.5),
    "America/Halifax": (-69.2, 43.3, -57.0, 60.5),
    "America/New_York": (-95.2, 41.6, -57.0, 62.7),
    "America/Toronto": (-95.2, 41.6, -57.0, 62.7),
    "America/Chicago": (-102.1, 48.9, -88.0, 60.1),
    "America/Winnipeg": (-102.1, 48.9, -88.0, 60.1),
    "America/Regina": (-110.1, 48.9, -101.3, 60.1),
    "America/Denver": (-120.1, 48.9, -101.9, 62.5),
    "America/Edmonton": (-120.1, 48.9, -101.9, 62.5),
    "America/Los_Angeles": (-141.1, 45.5, -114.0, 69.7),
    "America/Vancouver": (-141.1, 45.5, -114.0, 69.7),
}

# Firefly properties CampSwoop can watch (Firefly has no public property list). near is (lng, lat): the
# listed point, used when Photon doesn't confirm a fairgrounds/campground within 3 km of it.
FIREFLY = [
    {"slug": "NCStateFairCampground", "name": "N.C. State Fairgrounds Campground", "area": "Raleigh, NC",
     "near": (-78.71, 35.79), "queries": ["North Carolina State Fairgrounds", "NC State Fairgrounds",
                                          "State Fairgrounds Raleigh"]},
]

# Where Recreation.gov places may be: (min lng, min lat, max lng, max lat).
US_BOXES = {
    "contiguous US": (-125.0, 24.3, -66.8, 49.5),
    "Alaska": (-180.0, 51.0, -129.9, 71.6),
    "Alaska west of 180°": (172.0, 51.0, 180.0, 53.1),
    "Hawaii": (-178.5, 18.8, -154.7, 28.5),
    "Puerto Rico": (-67.95, 17.85, -65.2, 18.55),
    "US Virgin Islands": (-65.1, 17.65, -64.55, 18.45),
    "Guam": (144.6, 13.2, 145.0, 13.7),
}

# State name -> (USPS code, bounding box). A Recreation.gov place more than STATE_MARGIN degrees outside
# the box of the state it claims is dropped as misplaced.
STATES = {
    "Alabama": ("AL", (-88.48, 30.14, -84.89, 35.01)), "Alaska": ("AK", (-180.0, 51.0, -129.9, 71.6)),
    "Arizona": ("AZ", (-114.82, 31.33, -109.04, 37.0)), "Arkansas": ("AR", (-94.62, 33.0, -89.64, 36.5)),
    "California": ("CA", (-124.41, 32.53, -114.13, 42.01)), "Colorado": ("CO", (-109.06, 36.99, -102.04, 41.0)),
    "Connecticut": ("CT", (-73.73, 40.98, -71.79, 42.05)), "Delaware": ("DE", (-75.79, 38.45, -75.05, 39.84)),
    "District of Columbia": ("DC", (-77.12, 38.79, -76.91, 39.0)), "Florida": ("FL", (-87.63, 24.4, -79.97, 31.0)),
    "Georgia": ("GA", (-85.61, 30.36, -80.84, 35.0)), "Hawaii": ("HI", (-178.5, 18.8, -154.7, 28.5)),
    "Idaho": ("ID", (-117.24, 41.99, -111.04, 49.0)), "Illinois": ("IL", (-91.51, 36.97, -87.5, 42.51)),
    "Indiana": ("IN", (-88.1, 37.77, -84.78, 41.76)), "Iowa": ("IA", (-96.64, 40.38, -90.14, 43.5)),
    "Kansas": ("KS", (-102.05, 36.99, -94.59, 40.0)), "Kentucky": ("KY", (-89.57, 36.5, -81.96, 39.15)),
    "Louisiana": ("LA", (-94.04, 28.93, -88.82, 33.02)), "Maine": ("ME", (-71.08, 43.06, -66.95, 47.46)),
    "Maryland": ("MD", (-79.49, 37.91, -75.05, 39.72)), "Massachusetts": ("MA", (-73.51, 41.24, -69.93, 42.89)),
    "Michigan": ("MI", (-90.42, 41.7, -82.12, 48.31)), "Minnesota": ("MN", (-97.24, 43.5, -89.49, 49.38)),
    "Mississippi": ("MS", (-91.66, 30.17, -88.1, 34.99)), "Missouri": ("MO", (-95.77, 35.99, -89.1, 40.61)),
    "Montana": ("MT", (-116.05, 44.36, -104.04, 49.0)), "Nebraska": ("NE", (-104.05, 40.0, -95.31, 43.0)),
    "Nevada": ("NV", (-120.01, 35.0, -114.04, 42.0)), "New Hampshire": ("NH", (-72.56, 42.7, -70.61, 45.31)),
    "New Jersey": ("NJ", (-75.56, 38.93, -73.89, 41.36)), "New Mexico": ("NM", (-109.05, 31.33, -103.0, 37.0)),
    "New York": ("NY", (-79.76, 40.5, -71.86, 45.02)), "North Carolina": ("NC", (-84.32, 33.84, -75.46, 36.59)),
    "North Dakota": ("ND", (-104.05, 45.94, -96.55, 49.0)), "Ohio": ("OH", (-84.82, 38.4, -80.52, 41.98)),
    "Oklahoma": ("OK", (-103.0, 33.62, -94.43, 37.0)), "Oregon": ("OR", (-124.57, 41.99, -116.46, 46.29)),
    "Pennsylvania": ("PA", (-80.52, 39.72, -74.69, 42.27)), "Rhode Island": ("RI", (-71.91, 41.15, -71.12, 42.02)),
    "South Carolina": ("SC", (-83.35, 32.03, -78.54, 35.22)), "South Dakota": ("SD", (-104.06, 42.48, -96.44, 45.95)),
    "Tennessee": ("TN", (-90.31, 34.98, -81.65, 36.68)), "Texas": ("TX", (-106.65, 25.84, -93.51, 36.5)),
    "Utah": ("UT", (-114.05, 37.0, -109.04, 42.0)), "Vermont": ("VT", (-73.44, 42.73, -71.46, 45.02)),
    "Virginia": ("VA", (-83.68, 36.54, -75.24, 39.47)), "Washington": ("WA", (-124.85, 45.54, -116.92, 49.0)),
    "West Virginia": ("WV", (-82.64, 37.2, -77.72, 40.64)), "Wisconsin": ("WI", (-92.89, 42.49, -86.25, 47.31)),
    "Wyoming": ("WY", (-111.06, 40.99, -104.05, 45.01)), "Puerto Rico": ("PR", (-67.95, 17.85, -65.2, 18.55)),
    "Virgin Islands": ("VI", (-65.1, 17.65, -64.55, 18.45)), "Guam": ("GU", (144.6, 13.2, 145.0, 13.7)),
}
STATE_ALIASES = {"U.S. Virgin Islands": "Virgin Islands", "US Virgin Islands": "Virgin Islands",
                 "Saint John": "Virgin Islands", "Saint Thomas": "Virgin Islands", "Saint Croix": "Virgin Islands",
                 "St. John": "Virgin Islands", "St. Thomas": "Virgin Islands", "St. Croix": "Virgin Islands"}
USPS = {code: name for name, (code, _) in STATES.items()}
STATE_MARGIN = 0.5


# --- HTTP ---------------------------------------------------------------------

def fetch_json(url):
    """GET url as JSON, retrying network errors, 429s and 5xx responses."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json",
                                                   "Accept-Encoding": "gzip"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return json.loads(body)
        except urllib.error.HTTPError as error:
            if error.code != 429 and error.code < 500 or attempt == 3:
                raise
            failure = error
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt == 3:
                raise
            failure = error
        print(f"  {url} failed ({failure}); retrying", file=sys.stderr)
        time.sleep(5 * (attempt + 1))


# --- Names --------------------------------------------------------------------

SMALL_WORDS = {"and", "at", "by", "for", "in", "of", "on", "the", "to"}
GOES_IN = {"BOAT", "WALK", "FLOAT", "HIKE", "DRIVE", "PADDLE", "BIKE", "CANOE", "RIDE", "SKI"}  # "Boat In"
KEEP_UPPER = {"ADA", "ATV", "BLM", "BSA", "CCC", "CG", "CJ", "COE", "HC", "KOA", "NF", "NFS", "NHP", "NHS",
              "NM", "NP", "NPS", "NRA", "NWR", "OHV", "ORV", "RV", "RVS", "SRA", "TVA", "US", "USA", "USACE",
              "USFS", "WMA", "YMCA", "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII", "XIII", "XIV",
              "XV", "XVI", "XX"}
CONTRACTIONS = {"S", "T", "D", "LL", "RE", "VE", "M"}  # Abram'S -> Abram's
WORD = re.compile(r"[A-Za-z0-9]+(?:['’][A-Za-z]+)*")


def tidy(text):
    """Collapse whitespace, turn underscores into spaces and separate a glued-on "(Word"."""
    text = " ".join((text or "").replace("_", " ").split())
    text = re.sub(r"(?<=[A-Za-z0-9.])\((?=[A-Za-z]{2})", " (", text)
    return re.sub(r"\s+\)", ")", re.sub(r"\(\s+", "(", text))


def name_case(text, state=""):
    """Tidy a name and title-case it if it's ALL CAPS; names that already use lowercase keep their case."""
    text = tidy(text)
    if not any(c.isupper() for c in text) or any(c.islower() for c in text):
        # Mixed case: only fix state codes written like "(Ok)".
        return re.sub(r"\(([A-Z][a-z])\)", lambda m: f"({m[1].upper()})" if m[1].upper() in USPS else m[0], text)
    words = list(WORD.finditer(text))
    out, end = [], 0
    for i, match in enumerate(words):
        out += [text[end:match.start()], case_word(text, words, i, state)]
        end = match.end()
    return "".join(out + [text[end:]])


def case_word(text, words, i, state):
    """Case one word of an ALL CAPS name, looking at the words around it."""
    match = words[i]
    word, upper = match.group(), match.group().upper()
    before = text[:match.start()]
    prev_char = before.rstrip()[-1:]
    next_char = text[match.end():].lstrip()[:1]
    first, last = i == 0, i == len(words) - 1
    if "'" in word or "’" in word:
        head, quote, tail = re.split(r"(['’])", word, maxsplit=1)
        if tail.upper() in CONTRACTIONS:  # Abram's
            return plain_case(head) + quote + tail.lower()
        if head.upper() == "D" and not first:  # Coeur d'Alene
            return "d" + quote + tail.capitalize()
        return head.capitalize() + quote + tail.capitalize()  # O'Neil, L'Anse
    if upper == "IN" and i and words[i - 1].group().upper() in GOES_IN:
        return "In"
    if upper in USPS and next_char != "." and (
            (prev_char == "(" and next_char in (")", "-", ",")) or (next_char == ")" and prev_char != "(")
            or (last and upper == state)):
        return upper  # (CA), (ID - Boise), (Aberdeen MS), ... - MS
    if (word.lower() in SMALL_WORDS and not first and before.endswith(" ") and next_char != "."
            and prev_char not in "-(/&:"):
        return word.lower()  # Lake of the Woods, but Nat. For. and Boat-In stay capitalized
    if not first and (upper in ("DE", "DEL") or upper in ("LA", "LAS", "LOS", "EL")
                      and words[i - 1].group().upper() in ("DE", "DEL")):
        return word.lower()  # Rio de las Vacas
    return plain_case(word)


def plain_case(word):
    upper = word.upper()
    if re.fullmatch(r"\d+(ST|ND|RD|TH)", upper):
        return upper[:-2] + upper[-2:].lower()  # 1st
    if any(c.isdigit() for c in word) or len(word) == 1 or upper in KEEP_UPPER:
        return upper  # 4WD, loop letters, initials, acronyms, roman numerals
    if upper.startswith("MC") and len(upper) > 3:
        return "Mc" + upper[2] + upper[3:].lower()  # McDonald
    return upper[0] + upper[1:].lower()


def english(values, field):
    """A Camis localized field in English (some locations list French first)."""
    values = values or []
    for value in values:
        if (value.get("cultureName") or "").lower().startswith("en") and value.get(field):
            return value[field]
    return values[0].get(field) if values else None


# --- Geometry -----------------------------------------------------------------

def inside(box, lng, lat):
    return box[0] <= lng <= box[2] and box[1] <= lat <= box[3]


def grow(box, margin):
    return box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin


def km(a, b):
    """Great-circle distance between two (lng, lat) points."""
    (lng1, lat1), (lng2, lat2) = a, b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2)
    return 12742 * math.asin(math.sqrt(h))


def valid_number(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


# --- Geocoding ----------------------------------------------------------------

class Photon:
    """Photon (OpenStreetMap) search, about one request a second, with every answer cached on disk."""
    URL = "https://photon.komoot.io/api/"

    def __init__(self, path):
        self.path = path
        self.cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.used = set()
        self.requests = 0
        self.last = 0.0

    def search(self, query, box):
        params = {"q": query, "limit": 5, "lang": "en", "bbox": ",".join(f"{round(v, 3):g}" for v in box)}
        key = urllib.parse.urlencode(params)
        self.used.add(key)
        if key not in self.cache:
            time.sleep(max(0.0, 1.05 - (time.monotonic() - self.last)))  # requests start >1 s apart
            self.last = time.monotonic()
            self.requests += 1
            data = fetch_json(f"{self.URL}?{key}")
            self.cache[key] = [self.simplify(feature) for feature in data.get("features") or []]
            if self.requests % 25 == 0:
                self.save()
        return self.cache[key]

    FIELDS = ("name", "osm_key", "osm_value", "countrycode", "state", "lnglat", "box")  # what's kept

    @staticmethod
    def simplify(feature):
        props = feature.get("properties") or {}
        lng, lat = (feature.get("geometry") or {}).get("coordinates") or (None, None)
        place = {key: props[key] for key in Photon.FIELDS if props.get(key)}
        place["lnglat"] = [round(lng, 6), round(lat, 6)] if valid_number(lng) and valid_number(lat) else None
        if props.get("extent"):  # Photon's extent is [west, north, east, south]
            west, north, east, south = props["extent"]
            place["box"] = [round(min(west, east), 5), round(min(north, south), 5),
                            round(max(west, east), 5), round(max(north, south), 5)]
        return place

    def save(self, prune=False):
        """Write the cache, one query per line; prune: keep only the queries this run used."""
        keys = sorted(self.used if prune else self.cache)
        lines = [json.dumps(key) + ":" + json.dumps([{k: place[k] for k in self.FIELDS if k in place}
                                                     for place in self.cache[key]],
                                                    ensure_ascii=False, separators=(",", ":"))
                 for key in keys if key in self.cache]
        self.path.write_text("{\n" + ",\n".join(lines) + "\n}\n", encoding="utf-8")


# Words that don't help tell one park from another when matching Photon's names to ours.
NAME_NOISE = {"provincial", "park", "parks", "national", "state", "marine", "reserve", "historic", "site",
              "campground", "campgrounds", "the", "of", "and", "et", "de", "du", "des", "la", "le", "les",
              "area", "recreation"}
# OSM tags (key, value) of Photon results: parks, campgrounds, and keys that are never either.
PARK_TYPES = {("boundary", "national_park"), ("boundary", "protected_area"), ("leisure", "nature_reserve"),
              ("leisure", "park")}
CAMP_TYPES = {("tourism", "camp_site"), ("tourism", "caravan_site")}
NEVER = {"highway", "railway", "building", "shop", "office", "aeroway", "power", "craft", "emergency"}


def tokens(text):
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return [t for t in re.split(r"[^a-z0-9]+", text) if t]


def core(text):
    """The words that identify a place, in order: no designations like "Provincial Park", no initials."""
    return [t for t in tokens(text) if t not in NAME_NOISE and (len(t) > 1 or t.isdigit())]


def same_token(a, b):
    """Equal, or equal but for a plural/possessive s, or (for long words) one typo apart."""
    if a == b or a.rstrip("s") == b.rstrip("s"):
        return True
    if min(len(a), len(b)) < 6 or abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i + (len(a) == len(b)):] == b[i + 1:]


def name_match(query, name, context=()):
    """None if the place's name doesn't contain the query's words in order; otherwise how many other
    words it has (fewer is better; words of the park's own name don't count)."""
    wanted, found = core(query), core(name)
    for start in range(len(found) - len(wanted) + 1):
        if wanted and all(same_token(w, f) for w, f in zip(wanted, found[start:start + len(wanted)])):
            return sum(1 for f in found if not any(same_token(f, w) for w in (*wanted, *context)))
    return None


def rank(place, level, query):
    """How well this kind of place stands in for a park ("park" level) or a campground inside one
    ("site", or "campground" for campgrounds only): 0 is best, None means not at all."""
    key, value = place.get("osm_key"), place.get("osm_value")
    if not place.get("lnglat"):
        return None
    if (key, value) in CAMP_TYPES:
        return 0
    if level == "campground":
        return None
    if key == "highway" and value in ("path", "track", "footway", "bridleway") and re.search(r"\bTrail\b", query):
        return 3  # "Berg Lake Trail" is only on the map as the trail itself
    if key in NEVER or (key == "boundary" and (key, value) not in PARK_TYPES):
        return None  # roads, buildings, electoral districts, ...
    if level == "site":
        if key == "tourism" or (key, value) in PARK_TYPES:
            return 1
        return 3 if key == "amenity" else 2
    if (key, value) in PARK_TYPES:
        return 0
    if key == "amenity":
        return None
    return 1 if key in ("tourism", "historic") else 2


class Locator:
    """Finds a Camis park or campground on the map by name, within its park system's region and its
    time zone, checking country, province and name."""

    def __init__(self, photon, system, time_zone=None):
        self.photon, self.system, self.cfg = photon, system, CAMIS[system]
        region, zone = self.cfg["box"], TIME_ZONE_BOXES.get(time_zone)
        self.box = region if not zone else (max(region[0], zone[0]), max(region[1], zone[1]),
                                            min(region[2], zone[2]), min(region[3], zone[3]))

    def find(self, queries, level, box=None, context=(), first_hit=False):
        """Best match for any of the queries: (place, query), or (None, None). Prefers parks and
        campgrounds, then names with fewer extra words, then the better kind of place, then earlier
        queries. first_hit: stop at the first query with any acceptable answer."""
        best = None
        for order, query in enumerate(dict.fromkeys(q for q in queries if core(q))):
            for index, place in enumerate(self.photon.search(query, box or self.box)):
                score = rank(place, level, query)
                extra = name_match(query, place.get("name"), context)
                if score is None or extra is None or not self.in_region(place):
                    continue
                key = (0 if score == 0 else 1, extra, score, order, index)
                if best is None or key < best[0]:
                    best = (key, place, query)
            if best and (first_hit or best[0][:2] == (0, 0)):
                break  # a park or campground with just this name: don't ask Photon more
        return (best[1], best[2]) if best else (None, None)

    def in_region(self, place):
        cfg = self.cfg
        return (inside(self.box, *place["lnglat"]) and (place.get("countrycode") or "").upper() == cfg["country"]
                and (cfg["state"] is None or place.get("state") == cfg["state"]))

    def park_queries(self, park, part_of_name=False):
        """Queries for a park; part_of_name: park is the "Park" in "Park - Site"."""
        park = re.sub(r"\s+Backcountry$", "", park).strip()
        if self.system == "p":
            if park in PC_PARKS:
                return [PC_PARKS[park], f"{park} National Park", park]
            if re.search(r"National (Park|Historic Site)", park):  # Chilkoot Trail National Historic Site
                return [park, re.sub(r"\s+National (Park|Historic Site)\b.*$", "", park)]
            if part_of_name:  # "Lake Louise - ...", "Icefields Parkway - ..."
                return [f"{park} Campground", park]
            return [f"{park} National Historic Site", park]  # Rideau Canal, Fort Langley, ...
        if self.system == "w":
            return [park] if park.endswith("State Park") else [f"{park} State Park", park]
        if re.search(r"\bParks?$", park):
            alternatives = [park]
            if self.system == "b" and "Provincial" not in park:  # "X Marine Park" is "X Marine Provincial Park"
                alternatives.append(re.sub(r"\s+Park$", " Provincial Park", park))
            return alternatives
        return [f"{park} Provincial Park", park]

    @staticmethod
    def site_queries(site):
        queries = []
        for part in re.split(r"\s*(?:/|&|\band\b)\s*", site):
            part = re.sub(r"\s+Backcountry$", "", part).strip()
            shorter = re.sub(r"(?:\s+(?:\d+|Main|Lakeside|Village|Trailer|Court|Group|Loop|Area))+$", "", part)
            for name in dict.fromkeys([part, shorter]):
                if name:
                    queries += [name if re.search(r"\bCamp(ground|site)?$", name) else f"{name} Campground", name]
        return queries

    def locate(self, name):
        """(Photon place, how) for a Camis location name, or None. how: "site" (the campground itself),
        "park" (the park it's in, when the campground isn't on the map) or "name" (the whole name)."""
        if name in GEOCODE_AS:
            place, _ = self.find(GEOCODE_AS[name], "park", first_hit=True)
            return (place, "name") if place else None
        # "Tā Ch'ilā Park [a.k.a. Boya Lake Park]", "sẁiẁs Provincial Park (Haynes Point)"
        main = re.sub(r"\s*(\[[^\]]*\]|\([^)]*\))", "", name).strip()
        extra = [alt.strip() for a, b in re.findall(r"\[(?:a\.k\.a\.\s*)?([^\]]+)\]|\(([^)]+)\)", name)
                 for alt in (a or b).split(",")]
        if self.system == "w" and main.startswith("Retreat Center - "):
            subject = main.split(" - ", 1)[1]
            place, _ = self.find([f"{subject} Environmental Learning Center", f"{subject} Retreat Center",
                                  f"{subject} State Park", subject], "park")
            return (place, "name") if place else None
        parts = re.split(r"\s+[-–]\s+", main, maxsplit=1)
        if len(parts) == 2:  # "Park - Site"; the site may be "A / B" or "A & B"
            park, site = parts
            anchor, _ = self.find(self.park_queries(park, part_of_name=True), "park")
            if site.casefold() not in GENERIC_SITES:
                box = self.box_around(anchor) if anchor else None
                words = set(core(site))
                level = "campground" if words and words <= DIRECTIONS else "site"
                place, _ = self.find(self.site_queries(site), level, box=box, context=core(park))
                if place:
                    return place, "site"
            return (anchor, "park") if anchor else None
        if " / " in main:  # "Sx̱ótsaqel / Chilliwack Lake Park": look for the second name first
            first, second = main.split(" / ", 1)
            suffix = re.search(r"\s+((?:Provincial\s+|Marine\s+)?Parks?)$", second)
            main, extra = second, [first + (" " + suffix.group(1) if suffix else "")] + extra
        place, _ = self.find(self.park_queries(main), "park")
        for alternative in extra:
            if place:
                break
            if len(core(alternative)) >= 2 or re.search(r"\bPark$", alternative):
                suffix = "" if re.search(r"\bParks?$", alternative) else " Park"
                place, _ = self.find(self.park_queries(alternative + suffix) + [alternative], "park")
        return (place, "name") if place else None

    def box_around(self, anchor):
        """Search box for campgrounds inside a park: the park's extent, at least ±0.3° around it."""
        lng, lat = anchor["lnglat"]
        west, south, east, north = anchor.get("box") or (lng, lat, lng, lat)
        box = (min(west - 0.05, lng - 0.3), min(south - 0.05, lat - 0.3),
               max(east + 0.05, lng + 0.3), max(north + 0.05, lat + 0.3))
        return (max(box[0], self.box[0]), max(box[1], self.box[1]),
                min(box[2], self.box[2]), min(box[3], self.box[3]))


# --- Sources ------------------------------------------------------------------

class Report:
    def __init__(self):
        self.excluded = {}  # system -> [(name, why)]: not campgrounds CampSwoop can watch
        self.dropped = {}   # system -> [(name, why)]: campgrounds without a believable location
        self.repaired = []  # (system, name, what was fixed)
        self.how = {}       # system -> {"gps": n, "geocoded site": n, ...}: where coordinates came from

    def exclude(self, system, name, why):
        self.excluded.setdefault(system, []).append((name, why))

    def drop(self, system, name, why):
        self.dropped.setdefault(system, []).append((name, why))

    def located(self, system, how):
        counts = self.how.setdefault(system, {})
        counts[how] = counts.get(how, 0) + 1


def state_of(row):
    """(USPS code, name) of a Recreation.gov facility's state, from its state field or mailing address."""
    value = (row.get("state_code") or "").strip()
    value = STATE_ALIASES.get(value, value)
    if value in STATES:
        return STATES[value][0], value
    if value.upper() in USPS:
        return value.upper(), USPS[value.upper()]
    for address in row.get("addresses") or []:
        code = (address.get("state_code") or "").strip().upper()
        if code in USPS:
            return code, USPS[code]
    return "", ""


def us_point(lng, lat, code):
    """True if the point is in the US and near the state it claims."""
    box = STATES[USPS[code]][1] if code in USPS else None
    return (any(inside(us_box, lng, lat) for us_box in US_BOXES.values())
            and (box is None or inside(grow(box, STATE_MARGIN), lng, lat)))


def recreation_gov(report):
    rows, start, total = [], 0, None
    while total is None or start < total:
        data = fetch_json(RECGOV_SEARCH.format(start=start))
        results = data.get("results") or []
        total = data.get("total") or 0
        rows += results
        if not results or start > 20000:
            break
        start += len(results)
        time.sleep(0.5)
    print(f"Recreation.gov: {len(rows)} reservable campgrounds (API total {total})")
    places = []
    for row in rows:
        code, state = state_of(row)
        name = name_case(row.get("name"), code)
        ref = str(row.get("entity_id") or "")
        if "Overnight" not in (row.get("campsite_type_of_use") or []):
            uses = "/".join(row.get("campsite_type_of_use") or []) or "none"
            report.exclude("r", f"{name} ({ref})", f"no overnight sites ({uses})")
            continue
        parent = name_case(row.get("parent_name"), code)
        area = ", ".join(part for part in (parent, code) if part)
        try:
            lat, lng = float(row["latitude"]), float(row["longitude"])
        except (KeyError, TypeError, ValueError):
            report.drop("r", f"{name} ({ref}, {code})", "no coordinates")
            continue
        if not math.isfinite(lat) or not math.isfinite(lng) or lat == 0 or lng == 0:
            report.drop("r", f"{name} ({ref}, {code})", f"coordinates {lat}, {lng}")
            continue
        if not us_point(lng, lat, code):
            named = re.search(r"\(([A-Z]{2})\)", name)  # "Pines Campground (CO)" listed under Wyoming
            if named and named[1] in USPS and named[1] != code and us_point(lng, lat, named[1]):
                report.repaired.append(("r", f"{name} ({ref})", f"state {code} -> {named[1]}, as its name says"))
                code = named[1]
                area = ", ".join(part for part in (parent, code) if part)
            else:
                for fixed, what in (((-lng, lat), "longitude sign"), ((lat, lng), "lat/lng swapped"),
                                    ((-lat, lng), "lat/lng swapped and longitude sign")):
                    if us_point(*fixed, code):
                        report.repaired.append(("r", f"{name} ({ref}, {code})",
                                                f"{what}: {lat}, {lng} -> {fixed[1]}, {fixed[0]}"))
                        lng, lat = fixed
                        break
                else:
                    report.drop("r", f"{name} ({ref}, {code})", f"{lat}, {lng} is not in {state or 'the US'}")
                    continue
        places.append(["r", lng, lat, name, area, ref])
    return places


def parse_gps(text, box):
    """((lng, lat), note) from Camis text like "48.16386, -122.6782", "45.65°, -77.58°" or "Latitude: 49.69,
    Longitude: -86.90" if it's inside box, else (None, None). Also accepts it with lat/lng swapped or a
    lost minus sign, and says so in note."""
    numbers = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", text or "")]
    if len(numbers) != 2:
        return None, None
    a, b = numbers
    for lat, lng, note in ((a, b, None), (b, a, "lat/lng swapped"), (a, -abs(b), "longitude sign"),
                           (b, -abs(a), "lat/lng swapped and longitude sign")):
        if inside(box, lng, lat):
            return (lng, lat), note
    return None, None


def camis(system, photon, report):
    cfg = CAMIS[system]
    host = cfg["host"]
    locations = fetch_json(f"https://{host}/api/resourceLocation")
    categories = {c["resourceCategoryId"]: english(c.get("localizedValues"), "name") or ""
                  for c in fetch_json(f"https://{host}/api/resourcecategory")}
    print(f"{SYSTEMS[system]}: {len(locations)} locations")
    places = []
    for location in locations:
        name = tidy(english(location.get("localizedValues"), "fullName") or "")
        if location.get("rootMapId") is None:
            report.exclude(system, name, "no booking map")
            continue
        kinds = [categories.get(c, "") for c in location.get("resourceCategoryIds") or []]
        if all(kind.casefold() in NOT_OVERNIGHT for kind in kinds):
            report.exclude(system, name, "nothing to stay overnight in: " + (", ".join(kinds) or "nothing bookable"))
            continue
        ref = f"{location['resourceLocationId']}|{location['rootMapId']}"
        point, note = parse_gps(location.get("gpsCoordinates"), cfg["box"])
        if point:
            how = "gps"
            if note:
                report.repaired.append((system, name, f"{note}: {location.get('gpsCoordinates')}"))
        else:
            asked = photon.requests
            found = Locator(photon, system, location.get("ianaTimeZone")).locate(name)
            if not found:
                report.drop(system, name, "no believable location found")
                continue
            place, how = found
            point, how = place["lnglat"], f"geocoded {how}"
            if photon.requests > asked:  # newly geocoded: show what it matched
                print(f"  {name} -> {place.get('name')} ({place.get('osm_key')}={place.get('osm_value')}, "
                      f"{how}) {point[1]:.4f}, {point[0]:.4f}")
        report.located(system, how)
        if system == "p":
            park = re.split(r"\s+[-–]\s+", name, maxsplit=1)
            area = PC_AREAS.get(park[0], park[0]) if len(park) == 2 else cfg["area"]
        else:
            area = cfg["area"]
        places.append([system, point[0], point[1], name, area, ref])
    return places


def firefly(photon, report):
    places = []
    for prop in FIREFLY:
        lng, lat = prop["near"]
        box = STATES[USPS[prop["area"][-2:]]][1]
        found = None
        for query in prop["queries"]:
            for place in photon.search(query, box):
                if (place.get("lnglat") and km(prop["near"], place["lnglat"]) < 3
                        and {"fair", "fairground", "fairgrounds"} & set(tokens(place.get("name")))):
                    found = place
                    break
            if found:
                break
        if found:
            lng, lat = found["lnglat"]
            report.located("f", "photon")
            print(f"Firefly: {prop['name']} -> Photon \"{found.get('name')}\" "
                  f"({found.get('osm_key')}={found.get('osm_value')}) at {lat:.5f}, {lng:.5f}")
        else:
            report.located("f", "listed")
            print(f"Firefly: {prop['name']}: Photon didn't confirm the fairgrounds; using the listed point")
        places.append(["f", lng, lat, prop["name"], prop["area"], prop["slug"]])
    return places


# --- Output -------------------------------------------------------------------

REGIONS = {"r": list(US_BOXES.values()), "f": list(US_BOXES.values()),
           **{system: [cfg["box"]] for system, cfg in CAMIS.items()}}


def validate(places, report):
    """Round coordinates and drop places that are malformed, misplaced or listed twice."""
    seen, good = set(), []
    for system, lng, lat, name, area, ref in places:
        if not (valid_number(lng) and valid_number(lat) and -180 <= lng <= 180 and -90 <= lat <= 90):
            report.drop(system, name, f"bad coordinates {lng!r}, {lat!r}")
            continue
        lng, lat = round(lng, 4) + 0.0, round(lat, 4) + 0.0  # + 0.0 turns -0.0 into 0.0
        if lng == 0 and lat == 0:
            report.drop(system, name, "at 0,0")
        elif not any(inside(box, lng, lat) for box in REGIONS[system]):
            report.drop(system, name, f"{lat}, {lng} is outside the {SYSTEMS[system]} region")
        elif not name or not ref:
            report.drop(system, name or ref, "no name or id")
        elif (system, ref) in seen:
            report.drop(system, name, f"duplicate id {ref}")
        else:
            seen.add((system, ref))
            good.append([system, lng, lat, name, area, ref])
    order = list(SYSTEMS)
    return sorted(good, key=lambda p: (order.index(p[0]), p[3].casefold(), p[3], p[5]))


def today():
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.now(ZoneInfo("America/New_York")).date()
    except Exception:  # no time zone database on this machine
        return dt.date.today()


def write(places):
    head = json.dumps({"generated": today().isoformat(), "systems": SYSTEMS}, ensure_ascii=False,
                      separators=(",", ":"))
    rows = ",\n".join(json.dumps(place, ensure_ascii=False, separators=(",", ":")) for place in places)
    text = head[:-1] + ',"places":[\n' + rows + "\n]}\n"
    json.loads(text)  # must parse
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8", newline="\n")
    return text


def main():
    started = time.monotonic()
    report = Report()
    photon = Photon(CACHE)
    places = recreation_gov(report)
    try:
        for system in CAMIS:
            places += camis(system, photon, report)
        places += firefly(photon, report)
    finally:
        photon.save()
    places = validate(places, report)
    photon.save(prune=True)  # keep only the answers this run used
    text = write(places)

    raw = len(text.encode("utf-8"))
    packed = len(gzip.compress(text.encode("utf-8"), 9))
    print(f"\nWrote {OUTPUT} ({len(places)} places, {raw:,} bytes, {packed:,} gzipped) "
          f"in {time.monotonic() - started:.0f}s; Photon: {photon.requests} requests, "
          f"{len(photon.used)} queries used")
    for system, title in SYSTEMS.items():
        count = sum(1 for p in places if p[0] == system)
        how = ", ".join(f"{k} {v}" for k, v in sorted(report.how.get(system, {}).items()))
        print(f"  {system} {title}: {count}" + (f" ({how})" if how else ""))
    for label, items in (("Left out (not campgrounds CampSwoop can watch)", report.excluded),
                         ("Dropped (no believable location)", report.dropped)):
        for system, entries in items.items():
            print(f"\n{label}, {SYSTEMS[system]}: {len(entries)}")
            if len(entries) > 100:  # Recreation.gov's day-use areas: just count them
                reasons = {}
                for name, why in entries:
                    reasons.setdefault(why, []).append(name)
                for why, names in sorted(reasons.items(), key=lambda item: -len(item[1])):
                    print(f"  {len(names)} with {why}, e.g. {'; '.join(sorted(names)[:3])}")
                continue
            for name, why in sorted(entries):
                print(f"  {name}: {why}")
    if report.repaired:
        print(f"\nRepaired: {len(report.repaired)}")
        for system, name, what in report.repaired:
            print(f"  {SYSTEMS[system]}: {name}: {what}")


if __name__ == "__main__":
    main()
