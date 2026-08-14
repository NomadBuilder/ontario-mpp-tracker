#!/usr/bin/env python3
"""
Poll Ontario municipal meeting portals and flag datacentre-related items.

eScribe (pub-* and *publishing.escribemeetings.com), CivicPlus calendars
(calendar.*.ca / events.*.ca), Halton OnBase + website calendar, Toronto
TMMIS open-data schedule, and Ajax's published yearly schedule.

Merges data/meetings-curated.json (hand-entered votes, spills, proposals).

Usage:
  python3 scripts/fetch_meetings.py
  python3 scripts/fetch_meetings.py --priority high
"""

from __future__ import annotations

import argparse
import csv
import html as htmlmod
import io
import json
import re
import ssl
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parent.parent
REG_PATH = ROOT / "data" / "municipalities.json"
CURATED_PATH = ROOT / "data" / "meetings-curated.json"
OUT_PATH = ROOT / "data" / "meetings.json"

UA = (
    "Mozilla/5.0 (compatible; OAC-MeetingWatch/0.1; "
    "+https://github.com/NomadBuilder/ontario-mpp-tracker)"
)
CTX = ssl.create_default_context()

EXACT_KEYWORDS = [
    r"data[\s-]?cent(?:re|er)s?",
    r"datacent(?:re|er)s?",
]
BROAD_KEYWORDS = [
    r"data[\s-]?halls?",
    r"data[\s-]?campus",
    r"data storage facility",
    r"server farms?",
    r"server campus",
    r"server facility",
    r"hyperscale",
    r"colocation",
    r"co-location",
    r"\bcolo\b",
    r"cloud campus",
    r"cloud computing",
    r"compute campus",
    r"compute cluster",
    r"\bAI campus\b",
    r"AI factory",
    r"AI cluster",
    r"AI infrastructure",
    r"high[\s-]?performance comput",
    r"GPU cluster",
    r"GPU campus",
    r"digital infrastructure",
    r"large[\s-]?load (?:facility|customer|connection)",
    r"connection impact assessment",
    r"system impact assessment",
    r"interim control.{0,40}data",
    r"data.{0,40}interim control",
    r"crypto(?:currency)?[\s-]?min(?:e|ing)",
    r"bitcoin[\s-]?min(?:e|ing)",
    r"\bprologis\b",
    r"\bequinix\b",
    r"\bcologix\b",
    r"\bvantage data\b",
    r"\bcyrusone\b",
    r"\bqscale\b",
    r"estruxture",
    r"digital realty",
    r"compass datacent",
    r"\burbacon\b",
    r"\byto\s?\d+\b",
    r"amazon web services",
    r"\bmicrosoft azure\b",
]
WATER_EXACT_KEYWORDS = [
    r"water[\s-]?privatiz",
    r"privatiz\w{0,12}\s+(?:of\s+)?(?:the\s+)?water",
    r"private[\s-]?sector\s+water",
    r"sell(?:ing)?\s+(?:the\s+)?(?:city'?s\s+|municipal\s+)?water\s+(?:utility|system|works|service)",
    r"sale\s+of\s+(?:the\s+)?(?:city'?s\s+|municipal\s+)?water\s+(?:utility|system|works|service)",
    r"private\s+water\s+(?:utility|company|operator|provider)",
]
WATER_BROAD_KEYWORDS = [
    r"water\s+utility\s+(?:sale|sell|privat|concession|franchise|transfer)",
    r"(?:P3|PPP|public[\s-]private)\s+.{0,20}water",
    r"water\s+.{0,20}(?:P3|PPP|public[\s-]private)",
    r"outsourc\w*\s+water\s+servic",
    r"water\s+servic\w*\s+outsourc",
    r"private\s+operator.{0,40}water",
    r"water.{0,40}private\s+operator",
    r"\bveolia\b",
    r"\bsuez\b.{0,30}water",
    r"american\s+water\s+(?:works|company)",
    r"\bepcor\b",
    r"waterworks\s+(?:sale|privat|concession|transfer)",
    r"corporatiz\w*\s+water",
    r"water\s+corporatiz",
    r"concession\s+agreement.{0,40}water",
    r"water.{0,40}concession\s+agreement",
    r"bulk\s+water\s+(?:sale|export|agreement)",
    r"water\s+franchise",
]
DC_RE = re.compile("|".join(EXACT_KEYWORDS + BROAD_KEYWORDS), re.I)
DC_EXACT_RE = re.compile("|".join(EXACT_KEYWORDS), re.I)
WATER_RE = re.compile("|".join(WATER_EXACT_KEYWORDS + WATER_BROAD_KEYWORDS), re.I)
WATER_EXACT_RE = re.compile("|".join(WATER_EXACT_KEYWORDS), re.I)
KEYWORD_RE = re.compile(
    "|".join(EXACT_KEYWORDS + BROAD_KEYWORDS + WATER_EXACT_KEYWORDS + WATER_BROAD_KEYWORDS),
    re.I,
)
EXACT_RE = DC_EXACT_RE  # backward-compatible alias used in curated merge

DECISION_BODY = re.compile(
    r"council|planning|committee of the whole|committee of adjustment|"
    r"public meeting|public hearing|special council|general committee|"
    r"general government|development|economic|infrastructure|works committee|"
    r"zoning|site plan|finance and administration|community affairs",
    re.I,
)
# Open these first — CoA is listed for scanning but rarely names a data centre in the title.
INSPECT_BODY = re.compile(
    r"council|planning|general committee|general government|committee of the whole|"
    r"public meeting|public hearing|economic|infrastructure|works committee|"
    r"development committee|community affairs|finance and administration",
    re.I,
)

SKIP_BODY = re.compile(
    r"christmas|thanksgiving|civic holiday|family day|good friday|"
    r"labour day|victoria day|canada day|cancelled-",
    re.I,
)

MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}


def fetch(url: str, timeout: int = 35, accept: str = "text/html,application/xhtml+xml") -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  fail {url} ({e})", flush=True)
        return None


def fetch_json(url: str, payload: dict, referer: str, timeout: int = 25):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": UA,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/json; charset=utf-8",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": referer,
            "Origin": referer.rstrip("/"),
        },
    )
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
        print(f"  fail {url} ({e})", flush=True)
        return None


def clock_from_dt(dt: datetime) -> str:
    hour = dt.hour
    ampm = "AM" if hour < 12 else "PM"
    h = hour % 12 or 12
    return f"{h}:{dt.minute:02d} {ampm}"


def clock_from_hhmm(hhmm: str) -> str:
    if not re.fullmatch(r"\d{3,4}", hhmm or ""):
        return ""
    raw = int(hhmm)
    hour, minute = divmod(raw, 100)
    if hour > 23 or minute > 59:
        return ""
    return clock_from_dt(datetime(2000, 1, 1, hour, minute))


def strip_tags(blob: str) -> str:
    blob = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", blob)
    blob = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", blob)
    blob = re.sub(r"(?s)<[^>]+>", " ", blob)
    blob = htmlmod.unescape(blob)
    return re.sub(r"\s+", " ", blob).strip()


MONTH_ALT = (
    r"January|February|March|April|May|June|July|August|September|October|November|December|"
    r"Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec"
)
TIME_ALT = r"(?:\s*@\s*(\d{1,2}:\d{2}\s*[AP]M))?"


def _fmt_time(t: str) -> str:
    t = (t or "").replace(" ", "").upper()
    if t and ":" in t:
        t = re.sub(r"(\d)(AM|PM)$", r"\1 \2", t)
    return t


def parse_when(label: str) -> tuple[str, str]:
    """Return (YYYY-MM-DD, time string) from an eScribe aria-label or page text."""
    text = htmlmod.unescape(label or "")
    # eScribe homes use day-month-year: "Thursday, 13 August 2026 @ 9:30 AM"
    m = re.search(
        rf"(\d{{1,2}})\s+({MONTH_ALT})\.?\s+(20\d{{2}}){TIME_ALT}",
        text,
        re.I,
    )
    if m:
        day = int(m.group(1))
        month = MONTHS[m.group(2).lower().rstrip(".")]
        year = int(m.group(3))
        return f"{year:04d}-{month:02d}-{day:02d}", _fmt_time(m.group(4) or "")
    # US / correspondence: "August 13, 2026" or "August 13, 2026 @ 9:30 AM"
    m = re.search(
        rf"({MONTH_ALT})\.?\s+(\d{{1,2}}),?\s+(20\d{{2}}){TIME_ALT}",
        text,
        re.I,
    )
    if m:
        month = MONTHS[m.group(1).lower().rstrip(".")]
        day = int(m.group(2))
        year = int(m.group(3))
        return f"{year:04d}-{month:02d}-{day:02d}", _fmt_time(m.group(4) or "")
    m2 = re.search(r"(20\d{2})-(\d{2})-(\d{2})", text)
    if m2:
        return f"{m2.group(1)}-{m2.group(2)}-{m2.group(3)}", ""
    return "", ""


def parse_escribe_home(html: str, base: str) -> list[dict]:
    parts = html.split('class="calendar-item"')
    out: list[dict] = []
    seen: set[str] = set()
    for chunk in parts[1:]:
        title = ""
        label = ""
        tm = re.search(
            r"<(?:a|span)[^>]*aria-label=['\"]([^'\"]+)['\"][^>]*>([^<]+)</(?:a|span)>",
            chunk,
            re.I,
        )
        if tm:
            label, title = tm.group(1), htmlmod.unescape(tm.group(2)).strip()
        if not title:
            ht = re.search(r"class=['\"]meeting-title-heading['\"][^>]*>\s*(?:<[^>]+>)?([^<]+)", chunk, re.I)
            if ht:
                title = htmlmod.unescape(ht.group(1)).strip()
        dm = re.search(r'class="meeting-date"[^>]*>([^<]+)', chunk, re.I)
        if dm:
            date_label = htmlmod.unescape(dm.group(1)).strip()
            label = f"{label} {date_label}".strip() if label else date_label
        mid = ""
        for pat in [
            r"Meeting\.aspx\?Id=([0-9a-fA-F-]{36})",
            r"Meeting\?Id=([0-9a-fA-F-]{36})",
            r"MeetingId=([0-9a-fA-F-]{36})",
            r"Id%3D([0-9a-fA-F-]{36})",
        ]:
            mm = re.search(pat, chunk, re.I)
            if mm:
                mid = mm.group(1).lower()
                break
        if not title:
            continue
        if not mid:
            mid = re.sub(r"[^a-z0-9]+", "-", title.lower())[:48]
        if mid in seen:
            continue
        seen.add(mid)
        url = urljoin(base.rstrip("/") + "/", f"Meeting.aspx?Id={mid}")
        day, tim = parse_when(label)
        loc = ""
        lm = re.search(r'class="[^"]*startLocation[^"]*"[^>]*>([^<]+)', chunk, re.I)
        if not lm:
            lm = re.search(r'class="[^"]*location[^"]*"[^>]*>([^<]+)', chunk, re.I)
        if lm:
            loc = htmlmod.unescape(lm.group(1)).strip()
        cancelled = bool(re.search(r"\bcancelled\b", chunk[:1500], re.I))
        out.append(
            {
                "id": mid,
                "body": title,
                "label": label,
                "date": day,
                "time": tim,
                "location": loc,
                "url": url,
                "cancelled": cancelled,
            }
        )
    return out


def extract_snippets(text: str, limit: int = 2) -> list[str]:
    snippets: list[str] = []
    for m in KEYWORD_RE.finditer(text):
        start = max(0, m.start() - 90)
        end = min(len(text), m.end() + 140)
        bit = text[start:end].strip()
        bit = re.sub(r"\s+", " ", bit)
        if bit and bit not in snippets:
            snippets.append(bit)
        if len(snippets) >= limit:
            break
    return snippets


def participation_from_text(text: str) -> dict:
    low = text.lower()
    deputations = None
    if re.search(r"deputation|delegation|public registr", low):
        deputations = True
    attend = True
    notes = []
    if "closed session" in low and "open session" not in low[:400]:
        notes.append("May include a closed session — public items only.")
    reg = re.search(r"register(?:ed|ation)? by ([A-Z][a-z]+ \d{1,2}(?:, 20\d{2})?)", text, re.I)
    register_by = reg.group(1) if reg else None
    return {
        "attend": attend,
        "deputations": deputations,
        "registerBy": register_by,
        "notes": " ".join(notes),
    }


def classify_topics(blob: str, keywords: list[str] | None = None) -> dict[str, str]:
    """Return {topic: 'exact'|'broad'} for datacentre and water privatization hits."""
    text = blob or ""
    keys = " ".join(keywords or [])
    combined = f"{text} {keys}"
    topics: dict[str, str] = {}
    if DC_RE.search(combined):
        topics["datacentre"] = (
            "exact" if DC_EXACT_RE.search(combined) or any(DC_EXACT_RE.search(k) for k in (keywords or [])) else "broad"
        )
    if WATER_RE.search(combined):
        topics["water"] = (
            "exact"
            if WATER_EXACT_RE.search(combined) or any(WATER_EXACT_RE.search(k) for k in (keywords or []))
            else "broad"
        )
    return topics


def why_for(keywords: list[str], topics: dict[str, str] | None = None) -> str:
    topics = topics or {}
    if any("interim control" in k.lower() for k in keywords):
        return "An interim control by-law can pause approvals while staff study power, water, and land-use impacts."
    if any("prologis" in k.lower() for k in keywords):
        return "Data-centre-ready industrial campuses can lock in huge electricity and water demand before an operator is named."
    if topics.get("water") and not topics.get("datacentre"):
        return (
            "Privatizing or outsourcing municipal water can lock residents into private operators and weaker public control — "
            "show up before the vote if you want deputations on the record."
        )
    if topics.get("water") and topics.get("datacentre"):
        return (
            "Data-centre and water decisions often travel together — huge new loads on the public system, "
            "or pressure to contract out utilities. Show up before the vote."
        )
    return (
        "Data-centre proposals often hide in zoning, site plan, or 'employment land' items — "
        "show up before the vote if you want deputations on the record."
    )


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def item_key(it: dict) -> str:
    # Overlay curated copy onto the scraped sitting: same city, date, and body.
    return "|".join(
        [
            (it.get("municipalityId") or "").lower(),
            (it.get("date") or ""),
            re.sub(r"\s+", " ", (it.get("body") or it.get("title") or "").lower())[:80],
        ]
    )


def merge_items(existing: list[dict], incoming: list[dict]) -> list[dict]:
    buckets: dict[str, dict] = {}
    order: list[str] = []
    for it in existing + incoming:
        key = item_key(it)
        if key not in buckets:
            buckets[key] = it
            order.append(key)
            continue
        prev = buckets[key]
        # Prefer curated copy; union links/keywords
        if it.get("curated") and not prev.get("curated"):
            merged = {**it}
            merged["links"] = {**(prev.get("links") or {}), **(it.get("links") or {})}
            buckets[key] = merged
        elif prev.get("curated") and not it.get("curated"):
            prev["links"] = {**(it.get("links") or {}), **(prev.get("links") or {})}
        else:
            if len(it.get("issue") or "") > len(prev.get("issue") or ""):
                buckets[key] = {**prev, **it, "curated": prev.get("curated") or it.get("curated")}
    return [buckets[k] for k in order]


def list_escribe_calendar(base: str, start: date, end: date) -> list[dict]:
    url = base.rstrip("/") + "/MeetingsCalendarView.aspx/GetCalendarMeetings"
    payload = {
        "calendarStartDate": start.isoformat(),
        "calendarEndDate": end.isoformat(),
    }
    data = fetch_json(url, payload, referer=base.rstrip("/") + "/")
    rows = (data or {}).get("d") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        mid = str(row.get("ID") or "").lower()
        title = (row.get("MeetingName") or "").strip()
        if not title:
            continue
        if not mid:
            mid = re.sub(r"[^a-z0-9]+", "-", title.lower())[:48]
        if mid in seen:
            continue
        seen.add(mid)
        day, tim = "", ""
        start_raw = row.get("StartDate") or row.get("FormattedStart") or ""
        try:
            dt = datetime.strptime(str(start_raw)[:19], "%Y/%m/%d %H:%M:%S")
            day, tim = dt.date().isoformat(), clock_from_dt(dt)
        except ValueError:
            day, tim = parse_when(str(row.get("FormattedStart") or start_raw))
        loc = strip_tags(row.get("Location") or row.get("Description") or "")
        cancelled = bool(re.search(r"\bcancelled\b", title, re.I))
        href = (row.get("Url") or "").strip()
        if href and re.search(r"Meeting\.aspx", href, re.I):
            meeting_url = urljoin(base.rstrip("/") + "/", href)
        else:
            meeting_url = f"{base.rstrip('/')}/Meeting.aspx?Id={mid}"
        out.append(
            {
                "id": mid,
                "body": title,
                "label": row.get("FormattedStart") or "",
                "date": day,
                "time": tim,
                "location": loc,
                "url": meeting_url,
                "cancelled": cancelled,
            }
        )
    return out


def scrape_escribe(portal: dict, horizon: date, inspect_all: bool) -> list[dict]:
    base = portal["base"].rstrip("/")
    start = date.today() - timedelta(days=7)
    raw_meetings = list_escribe_calendar(base, start, horizon)
    html = fetch(base + "/")
    if html:
        for mtg in parse_escribe_home(html, base):
            if not any(m["id"] == mtg["id"] for m in raw_meetings):
                raw_meetings.append(mtg)
    print(f"  {portal['id']}: {len(raw_meetings)} listed", flush=True)
    return items_from_raw(portal, raw_meetings, horizon, inspect_all, source="escribe")


def scrape_civicplus(portal: dict, horizon: date, inspect_all: bool) -> list[dict]:
    cal = (portal.get("calendarUrl") or "").rstrip("/")
    html = fetch(cal, timeout=45)
    if not html:
        return []
    raw: list[dict] = []
    seen: set[str] = set()
    for href, day, hhmm, slug, title in re.findall(
        r'href="(/meetings/Detail/(\d{4}-\d{2}-\d{2})-(\d{4})-([^"]+))"[^>]*>([^<]+)',
        html,
        re.I,
    ):
        title = htmlmod.unescape(title).strip() or slug.replace("-", " ").strip()
        mid = f"{day}-{hhmm}-{slug[:40]}"
        if mid in seen:
            continue
        seen.add(mid)
        raw.append(
            {
                "id": mid,
                "body": title,
                "label": f"{title} {day}",
                "date": day,
                "time": clock_from_hhmm(hhmm),
                "location": "",
                "url": urljoin(cal + "/", href),
                "cancelled": bool(re.search(r"cancelled", title, re.I)),
            }
        )
    if not raw:
        for day, hhmm, slug in re.findall(
            r"/meetings/Detail/(\d{4}-\d{2}-\d{2})-(\d{4})-([^\"/<>]+)",
            html,
            re.I,
        ):
            mid = f"{day}-{hhmm}-{slug[:40]}"
            if mid in seen:
                continue
            seen.add(mid)
            title = re.sub(r"[-_]+", " ", slug).strip(" 2")
            raw.append(
                {
                    "id": mid,
                    "body": title,
                    "label": title,
                    "date": day,
                    "time": clock_from_hhmm(hhmm),
                    "location": "",
                    "url": f"{cal}/Detail/{day}-{hhmm}-{slug}",
                    "cancelled": bool(re.search(r"cancelled", title, re.I)),
                }
            )
    print(f"  {portal['id']}: {len(raw)} listed", flush=True)
    return items_from_raw(portal, raw, horizon, inspect_all, source="civicplus")


def scrape_halton(portal: dict, horizon: date, inspect_all: bool) -> list[dict]:
    raw: list[dict] = []
    seen: set[str] = set()

    site = fetch(portal.get("calendarUrl") or "", timeout=40) or ""
    event_urls = re.findall(
        r'href="(https://www\.halton\.ca/the-region/events/20\d{2}/[^"]+)"',
        site,
        re.I,
    )
    titles = [
        htmlmod.unescape(t).strip()
        for t in re.findall(r'class="event-title">([^<]+)</div>', site)
    ]
    # Pair by page order when counts match. Never fall back to the first
    # unrelated event URL — that shipped a Nov 4 link on the Dec 9 card.
    if len(titles) == len(event_urls):
        pairs = list(zip(titles, event_urls))
    else:
        pairs = []
        for title in titles:
            day, _ = parse_when(title)
            href = ""
            if day:
                try:
                    d = date.fromisoformat(day)
                    slug = f"{d.strftime('%B').lower()}-{d.day},-{d.year}"
                    href = next((u for u in event_urls if slug in u.lower()), "")
                except ValueError:
                    href = ""
            pairs.append((title, href or (portal.get("calendarUrl") or "")))
    for title, href in pairs:
        day, _ = parse_when(title)
        if not day:
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower())[:48]
        if slug in seen:
            continue
        seen.add(slug)
        raw.append(
            {
                "id": slug,
                "body": title,
                "label": title,
                "date": day,
                "time": "9:30 AM" if re.search(r"council", title, re.I) else "",
                "location": "Halton Regional Centre, 1151 Bronte Road, Oakville",
                "url": href,
                "cancelled": False,
            }
        )

    onbase = portal.get("onbaseUrl") or "https://edmweb.halton.ca/OnBaseAgendaOnline"
    start = date.today().replace(month=1, day=1)
    q = (
        f"{onbase.rstrip('/')}/Meetings/Search"
        f"?dropsv={start.strftime('%m/%d/%Y')}+00:00:00"
        f"&dropev={horizon.strftime('%m/%d/%Y')}+23:59:59"
        f"&dropid=11"
    )
    html = fetch(q, timeout=40) or ""
    for chunk in html.split('class="meeting-row"')[1:]:
        mid = re.search(r'data-meeting-id="(\d+)"', chunk)
        name = re.search(r'data-sortable-type="mtgName">([^<]+)', chunk)
        when = re.search(r'data-sortable-label="(\d{4}-\d{2}-\d{2})"', chunk)
        clock = re.search(r"(\d{1,2}:\d{2}\s*[AP]M)", chunk, re.I)
        if not name:
            continue
        title = htmlmod.unescape(name.group(1)).strip()
        day = when.group(1) if when else parse_when(chunk[:400])[0]
        key = mid.group(1) if mid else f"{day}-{title[:30]}"
        if key in seen:
            continue
        seen.add(key)
        view = f"{onbase.rstrip('/')}/Meetings/ViewMeeting?id={mid.group(1)}&doctype=1" if mid else onbase
        pdf = re.search(r'href="(/OnBaseAgendaOnline/Documents/Downloadfile/[^"]+Agenda[^"]+)"', chunk, re.I)
        raw.append(
            {
                "id": str(key),
                "body": title,
                "label": title,
                "date": day,
                "time": (clock.group(1).upper().replace("  ", " ") if clock else ""),
                "location": "Halton Regional Centre, 1151 Bronte Road, Oakville",
                "url": urljoin(onbase, pdf.group(1)) if pdf else view,
                "cancelled": bool(re.search(r"cancelled", title, re.I)),
            }
        )
    print(f"  {portal['id']}: {len(raw)} listed", flush=True)
    return items_from_raw(portal, raw, horizon, inspect_all, source="halton")


def scrape_toronto(portal: dict, horizon: date, inspect_all: bool) -> list[dict]:
    csv_url = portal.get("scheduleUrl") or (
        "https://ckan0.cf.opendata.inter.prod-toronto.ca/datastore/dump/08c8aedb-afba-41f5-830e-bbfb305ebbc7"
    )
    blob = fetch(csv_url, timeout=45, accept="text/csv,text/plain,*/*")
    if not blob:
        return []
    raw: list[dict] = []
    today = date.today()
    for row in csv.DictReader(io.StringIO(blob)):
        title = (row.get("Committee") or "").strip()
        day = (row.get("Date") or "").strip()
        if not title or not day:
            continue
        try:
            d = date.fromisoformat(day[:10])
        except ValueError:
            continue
        if d < today - timedelta(days=3) or d > horizon:
            continue
        if SKIP_BODY.search(title):
            continue
        if not DECISION_BODY.search(title):
            continue
        mtg_no = (row.get("MTG #") or "").strip()
        # Open data often says "City Council" while the live calendar uses a special-session
        # title (e.g. "S: City Council (urgent heritage matters)"). Keep meeting # for matching.
        label_bits = [title]
        if mtg_no:
            label_bits.append(f"meeting {mtg_no}")
        body = " · ".join(label_bits)
        mid = f"{day}-{re.sub(r'[^a-z0-9]+', '-', title.lower())[:40]}"
        raw.append(
            {
                "id": mid,
                "body": body,
                "label": f"{body} {day} {row.get('Start Time') or ''}",
                "date": day[:10],
                "time": (row.get("Start Time") or "").replace("  ", " ").strip(),
                "location": (row.get("Location") or "").strip(),
                "url": "https://www.toronto.ca/city-government/council/council-committee-meetings/",
                "cancelled": False,
            }
        )
    print(f"  {portal['id']}: {len(raw)} listed", flush=True)
    # Agendas on secure.toronto.ca are often 403 from this scraper — still list decision
    # bodies from the open-data schedule so organizers don't miss sittings.
    return items_from_raw(portal, raw, horizon, inspect_all=False, source="tmmis")

# Official 2026 schedule (events.ajax.ca/meetings currently returns an Error page).
# Refresh from https://ajax.ca/wp-content/uploads/2026/05/2026-Meeting-Schedule.pdf
# ajax.ca/meetings redirects to the live Power Apps public-meetings portal.
AJAX_SCHEDULE = [
    ("2026-09-08", "1:00 PM", "Community Affairs and Planning Committee"),
    ("2026-09-14", "1:00 PM", "General Government Committee"),
    ("2026-09-21", "1:00 PM", "Council"),
    ("2026-12-07", "1:00 PM", "Community Affairs and Planning Committee"),
    ("2026-12-14", "1:00 PM", "General Government Committee"),
    ("2026-12-14", "Following GGC", "Council"),
]


def scrape_ajax(portal: dict, horizon: date, inspect_all: bool) -> list[dict]:
    cal = portal.get("calendarUrl") or "https://ajax.ca/meetings"
    html = fetch(cal, timeout=20) or ""
    if html and "complication" not in html.lower() and "/meetings/Detail/" in html:
        return scrape_civicplus({**portal, "calendarUrl": cal}, horizon, inspect_all)
    raw = []
    for day, tim, title in AJAX_SCHEDULE:
        try:
            d = date.fromisoformat(day)
        except ValueError:
            continue
        if d > horizon:
            continue
        raw.append(
            {
                "id": f"{day}-{re.sub(r'[^a-z0-9]+', '-', title.lower())[:32]}",
                "body": title,
                "label": f"{title} {day} {tim}",
                "date": day,
                "time": tim,
                "location": "Town Hall, 65 Harwood Avenue South, Ajax",
                "url": "https://ajax.ca/meetings",
                "cancelled": False,
            }
        )
    print(f"  {portal['id']}: {len(raw)} from published schedule", flush=True)
    return items_from_raw(portal, raw, horizon, inspect_all, source="ajax")


def _parse_sarnia_day(day_s: str, mon_s: str, year_s: str) -> date | None:
    mon = MONTHS.get(mon_s.lower()[:3]) or MONTHS.get(mon_s.lower())
    if not mon:
        return None
    try:
        return date(int(year_s), mon, int(day_s))
    except ValueError:
        return None


def scrape_sarnia(portal: dict, horizon: date, inspect_all: bool) -> list[dict]:
    """Council sittings from CivicWeb meeting list + calendar.sarnia.ca series page."""
    agenda = (portal.get("agendaUrl") or "https://sarnia.civicweb.net/").rstrip("/") + "/"
    civicweb = portal.get("civicwebUrl") or (
        "https://sarnia.civicweb.net/Portal/MeetingInformation.aspx?Id=1593&Org=Cal"
    )
    seen: set[str] = set()
    raw: list[dict] = []

    def add(day: date, tim: str, title: str, url: str) -> None:
        if day < date.today() - timedelta(days=3) or day > horizon:
            return
        key = day.isoformat()
        if key in seen:
            return
        seen.add(key)
        raw.append(
            {
                "id": f"{key}-council",
                "body": title,
                "label": f"{title} {key} {tim}",
                "date": key,
                "time": tim,
                "location": "City Hall, Sarnia",
                "url": url,
                "cancelled": False,
            }
        )

    html = fetch(civicweb, timeout=25) or ""
    if html:
        text = strip_tags(html)
        for day_s, mon_s, year_s in re.findall(
            r"\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(20\d{2})\b",
            text,
            re.I,
        ):
            d = _parse_sarnia_day(day_s, mon_s, year_s)
            if d:
                add(d, "1:00 PM", "Regular Council", civicweb)

    # Recurring series page lists further-out Mondays the CivicWeb list sometimes omits.
    series = portal.get("seriesUrl") or (
        "https://calendar.sarnia.ca/default/Detail/2026-02-09-1300-Sarnia-City-Council"
    )
    cal_html = fetch(series, timeout=20) or ""
    for mon_name, day_s, year_s, tim in re.findall(
        r"(?:Monday|Tuesday|Wednesday|Thursday|Friday),\s+"
        r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+"
        r"(\d{1,2}),\s+(20\d{2})\s+(\d{1,2}:\d{2}\s*[ap]m)",
        cal_html,
        re.I,
    ):
        d = _parse_sarnia_day(day_s, mon_name, year_s)
        if not d:
            continue
        hhmm = tim.upper().replace(" ", "")
        # Normalize 1:00pm → keep display time; build Detail slug as HHMM military-ish from clock
        m = re.match(r"(\d{1,2}):(\d{2})\s*([AP]M)", tim, re.I)
        slug_hhmm = "1300"
        display = "1:00 PM"
        if m:
            hh, mm, ap = int(m.group(1)), m.group(2), m.group(3).upper()
            display = f"{hh}:{mm} {ap}"
            if ap == "PM" and hh != 12:
                hh += 12
            if ap == "AM" and hh == 12:
                hh = 0
            slug_hhmm = f"{hh:02d}{mm}"
        detail = (
            f"https://calendar.sarnia.ca/default/Detail/"
            f"{d.isoformat()}-{slug_hhmm}-Sarnia-City-Council"
        )
        add(d, display, "Sarnia City Council", detail)

    print(f"  {portal['id']}: {len(raw)} listed", flush=True)
    items = items_from_raw(portal, raw, horizon, inspect_all, source="sarnia")
    for it in items:
        it.setdefault("links", {})
        it["links"].setdefault("agenda", agenda)
        it["links"].setdefault("source", civicweb)
    return items


def items_from_raw(
    portal: dict,
    raw_meetings: list[dict],
    horizon: date,
    inspect_all: bool,
    source: str,
) -> list[dict]:
    raw_meetings = sorted(raw_meetings, key=lambda m: m.get("date") or "9999")
    items: list[dict] = []
    inspected = 0
    for mtg in raw_meetings:
        if SKIP_BODY.search(mtg["body"] or ""):
            continue
        day = mtg["date"]
        if day:
            try:
                d = date.fromisoformat(day)
            except ValueError:
                d = None
            if d and d > horizon:
                continue
        decision = bool(DECISION_BODY.search(mtg["body"] or ""))
        hit_title = bool(KEYWORD_RE.search(mtg["body"] + " " + (mtg.get("label") or "")))
        snippets: list[str] = []
        page_text = ""
        inspect_body = bool(INSPECT_BODY.search(mtg["body"] or ""))
        within = True
        if day:
            try:
                within = date.fromisoformat(day) <= horizon
            except ValueError:
                within = True
        should_open = hit_title or (
            (inspect_body or inspect_all) and decision and (inspect_all or not day or within)
        )
        if should_open and mtg.get("url") and inspected < 18:
            page = fetch(mtg["url"])
            inspected += 1
            time.sleep(0.18)
            if page:
                page_text = strip_tags(page)[:20000]
                snippets = extract_snippets(page_text)
                if not mtg.get("date"):
                    candidates = []
                    tm = re.search(r"<title>([^<]+)</title>", page, re.I)
                    if tm:
                        candidates.append(htmlmod.unescape(tm.group(1)))
                    candidates.append(page_text[:4000])
                    candidates.extend(snippets)
                    for blob in candidates:
                        d2, t2 = parse_when(blob)
                        if d2:
                            mtg["date"] = d2
                            if t2 and not mtg.get("time"):
                                mtg["time"] = t2
                            break
        day = mtg.get("date") or ""
        keywords = []
        blob = f"{mtg['body']} {page_text}"
        for m in KEYWORD_RE.finditer(blob):
            k = m.group(0).lower()
            if k not in keywords:
                keywords.append(k)
        topics = classify_topics(blob, keywords)
        if snippets and not topics:
            # Snippet extractor only runs on keyword hits, so topics should usually be set;
            # keep a datacentre broad fallback if somehow only snippets fired.
            topics = classify_topics(" ".join(snippets), keywords)
        relevant = bool(topics or snippets or hit_title)
        if relevant and not topics and hit_title:
            topics = classify_topics(mtg["body"] + " " + (mtg.get("label") or ""), keywords)
        match_kind = topics.get("datacentre") or ""
        if not relevant and not decision:
            continue
        status = "upcoming"
        if day:
            try:
                status = "upcoming" if date.fromisoformat(day) >= date.today() else "past"
            except ValueError:
                pass
        if mtg["cancelled"]:
            status = "cancelled"
        issue = ""
        if snippets:
            issue = snippets[0]
        elif relevant:
            label = ", ".join(keywords) or (
                "water privatization terms" if topics.get("water") and not topics.get("datacentre") else "watch terms"
            )
            issue = f"Agenda or title flagged for: {label}."
        elif decision:
            # Keep a thin 'scan' card only for upcoming decision bodies with no keyword hit
            if status != "upcoming":
                continue
            if source == "tmmis":
                issue = (
                    "On Toronto’s open meeting schedule — open the city’s calendar to confirm the "
                    "exact title (special sittings are sometimes renamed there) and scan the agenda."
                )
            else:
                issue = "Decision meeting on the calendar — open the agenda and scan for zoning, site plan, utilities, or industrial items."
        part = participation_from_text(page_text or mtg.get("label") or "")
        if re.search(r"information package", mtg["body"] or "", re.I):
            part["attend"] = False
            part["deputations"] = False
            part["notes"] = (
                (part.get("notes") + " " if part.get("notes") else "")
                + "Correspondence package — not a sitting. Use it to brief the next council / planning meeting."
            ).strip()
        items.append(
            {
                "id": f"{portal['id']}-{mtg['id'][:16]}",
                "municipality": portal["name"],
                "municipalityId": portal["id"],
                "body": mtg["body"],
                "title": mtg["body"],
                "date": day,
                "time": mtg["time"],
                "location": mtg["location"],
                "status": status,
                "cancelled": mtg["cancelled"],
                "issue": issue,
                "why": why_for(keywords, topics) if relevant else "Public council / planning meetings are where zoning and servicing get decided — often with little notice.",
                "participate": part,
                "links": {
                    "meeting": mtg["url"],
                    "agenda": mtg["url"],
                },
                "keywordsMatched": keywords,
                "relevant": relevant,
                "matchKind": match_kind,
                "topics": topics,
                "source": source,
                "curated": False,
            }
        )
    return items

def probe_url(url: str, timeout: int = 14) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,*/*", "Accept-Language": "en-CA,en;q=0.9"},
    )
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=timeout) as resp:
            return resp.status, resp.geturl()
    except urllib.error.HTTPError as e:
        return e.code, str(e.reason or "")
    except Exception as e:  # noqa: BLE001
        return 0, type(e).__name__


def needs_live_check(url: str) -> bool:
    # eScribe Meeting.aspx?Id=<uuid> is built from the city's own calendar API.
    # The York-class 404s were city website / news / mismatched event URLs.
    if re.search(r"escribemeetings\.com/Meeting\.aspx\?Id=", url, re.I):
        return False
    return bool(url) and url.startswith("http")


def verify_outbound_links(items: list[dict], portals: list[dict]) -> None:
    fallback = {p["id"]: (p.get("calendarUrl") or p.get("base") or "") for p in portals}
    urls: dict[str, list[tuple[dict | None, str]]] = {}

    def add(url: str, item: dict | None, key: str) -> None:
        if needs_live_check(url):
            urls.setdefault(url, []).append((item, key))

    for it in items:
        for key, val in (it.get("links") or {}).items():
            if isinstance(val, str):
                add(val, it, key)
    for p in portals:
        for key in ("base", "calendarUrl", "onbaseUrl", "scheduleUrl"):
            add(p.get(key) or "", None, f"portal:{p.get('id')}:{key}")

    print(f"Checking {len(urls)} non-eScribe outbound links…", flush=True)
    broken = 0
    for url, refs in urls.items():
        code, detail = probe_url(url)
        if code in (200, 301, 302, 403):
            continue
        if code == 0:
            print(f"  warn {detail} {url}", flush=True)
            continue
        broken += 1
        print(f"  broken {code} {url}", flush=True)
        for it, key in refs:
            if it is None:
                continue
            fb = fallback.get(it.get("municipalityId") or "")
            if key == "meeting" and fb and fb != url:
                it["links"][key] = fb
                print(f"    replaced meeting on {it.get('id')} → {fb}", flush=True)
            elif key != "meeting":
                it["links"].pop(key, None)
                print(f"    dropped {key} on {it.get('id')}", flush=True)
    if not broken:
        print("  all checked links returned live", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--priority", default="all", help="all | high | medium (includes high)")
    ap.add_argument("--days", type=int, default=120, help="Look this many days ahead")
    ap.add_argument("--inspect-all", action="store_true", help="Open more meeting pages (slower)")
    args = ap.parse_args()

    registry = load_json(REG_PATH, {"portals": []})
    portals = list(registry.get("portals") or [])
    if args.priority == "high":
        portals = [p for p in portals if p.get("priority") == "high"]
    elif args.priority == "medium":
        portals = [p for p in portals if p.get("priority") in {"high", "medium"}]

    horizon = date.today() + timedelta(days=max(14, args.days))
    scraped: list[dict] = []
    coverage = []

    print(f"Polling {len(portals)} portals through {horizon.isoformat()}…", flush=True)
    for portal in portals:
        kind = portal.get("type")
        row = {
            "id": portal["id"],
            "name": portal["name"],
            "type": kind,
            "ok": False,
            "meetings": 0,
            "calendarUrl": portal.get("calendarUrl") or portal.get("base"),
            "note": portal.get("note") or "",
        }
        scrapers = {
            "escribe": scrape_escribe,
            "civicplus": scrape_civicplus,
            "halton": scrape_halton,
            "tmmis": scrape_toronto,
            "ajax": scrape_ajax,
            "sarnia": scrape_sarnia,
        }
        fn = scrapers.get(kind)
        if not fn:
            coverage.append(row)
            continue
        try:
            found = fn(portal, horizon, args.inspect_all)
            scraped.extend(found)
            row["ok"] = True
            row["meetings"] = len(found)
        except Exception as e:  # noqa: BLE001
            row["note"] = str(e)
            print(f"  {portal['id']}: error {e}", flush=True)
        coverage.append(row)
        time.sleep(0.25)

    curated = list((load_json(CURATED_PATH, {}) or {}).get("items") or [])
    for it in curated:
        it["curated"] = True
        it.setdefault("relevant", True)
        it.setdefault("source", "curated")
        it.setdefault("title", it.get("body") or it.get("title"))
        blob = " ".join(
            [
                it.get("title") or "",
                it.get("issue") or "",
                it.get("why") or "",
                it.get("result") or "",
                " ".join(it.get("keywordsMatched") or []),
            ]
        )
        topics = it.get("topics") if isinstance(it.get("topics"), dict) else None
        if not topics:
            topics = classify_topics(blob, list(it.get("keywordsMatched") or []))
            # Curated ICBL / data-centre votes without literal keywords still count as datacentre.
            if not topics and it.get("relevant"):
                topics = {"datacentre": "exact" if DC_EXACT_RE.search(blob) else "broad"}
            it["topics"] = topics
        if not it.get("matchKind"):
            it["matchKind"] = topics.get("datacentre") or ("exact" if DC_EXACT_RE.search(blob) else "broad")

    merged = merge_items(curated, scraped)

    def sort_key(it: dict) -> tuple:
        upcoming = 0 if it.get("status") == "upcoming" else 1 if it.get("status") == "watch" else 2
        return (upcoming, it.get("date") or "9999", it.get("municipality") or "")

    merged.sort(key=sort_key)
    verify_outbound_links(merged, portals)

    payload = {
        "asOf": datetime.now(timezone.utc).date().isoformat(),
        "note": (
            "Auto-polled eScribe, CivicPlus, Halton, Toronto TMMIS open data, and Ajax schedules. "
            "Keyword hits (data centres and water privatization) are flagged relevant; other upcoming council/planning meetings are listed so organizers can scan agendas. "
            "Not every Ontario municipality is covered yet — see coverage[]."
        ),
        "coverage": coverage,
        "items": merged,
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    rel = sum(1 for i in merged if i.get("relevant"))
    print(f"Wrote {len(merged)} items ({rel} keyword-flagged) → {OUT_PATH}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
