#!/usr/bin/env python3
"""
Poll Ontario municipal meeting portals and flag datacentre-related items.

Today: eScribe public sites listed in data/municipalities.json.
Gaps (Toronto TMMIS, CivicWeb-only, branded calendar subdomains) stay in the
registry so editors know what still needs a scraper.

Merges data/meetings-curated.json (hand-entered votes, spills, proposals).

Usage:
  python3 scripts/fetch_meetings.py
  python3 scripts/fetch_meetings.py --priority high
"""

from __future__ import annotations

import argparse
import html as htmlmod
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

KEYWORDS = [
    r"data[\s-]?cent(?:re|er)s?",
    r"datacent(?:re|er)s?",
    r"hyperscale",
    r"colocation",
    r"co-location",
    r"server farm",
    r"\bAI campus\b",
    r"cloud campus",
    r"data processing",
    r"large load facility",
    r"load connection",
    r"grid connection",
    r"interim control.{0,40}data",
    r"data.{0,40}interim control",
    r"\bprologis\b",
    r"\bequinix\b",
    r"\bcologix\b",
    r"\byto\s?11\b",
]
KEYWORD_RE = re.compile("|".join(KEYWORDS), re.I)

DECISION_BODY = re.compile(
    r"council|planning|committee of the whole|committee of adjustment|"
    r"public meeting|public hearing|special council|general committee|"
    r"development|economic|infrastructure|works committee|zoning|site plan",
    re.I,
)
# Open these first — CoA is listed for scanning but rarely names a data centre in the title.
INSPECT_BODY = re.compile(
    r"council|planning|general committee|committee of the whole|"
    r"public meeting|public hearing|economic development|"
    r"infrastructure|works committee|development committee",
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


def fetch(url: str, timeout: int = 35) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  fail {url} ({e})", flush=True)
        return None


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


def why_for(keywords: list[str]) -> str:
    if any("interim control" in k.lower() for k in keywords):
        return "An interim control by-law can pause approvals while staff study power, water, and land-use impacts."
    if any("prologis" in k.lower() for k in keywords):
        return "Data-centre-ready industrial campuses can lock in huge electricity and water demand before an operator is named."
    return (
        "Data-centre proposals often hide in zoning, site plan, or 'employment land' items — "
        "show up before the vote if you want deputations on the record."
    )


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def item_key(it: dict) -> str:
    return "|".join(
        [
            (it.get("municipalityId") or "").lower(),
            (it.get("date") or ""),
            re.sub(r"\s+", " ", (it.get("body") or it.get("title") or "").lower())[:80],
            (it.get("id") or "")[:36],
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


def scrape_escribe(portal: dict, horizon: date, inspect_all: bool) -> list[dict]:
    base = portal["base"].rstrip("/")
    html = fetch(base + "/")
    if not html:
        return []
    raw_meetings = parse_escribe_home(html, base)
    print(f"  {portal['id']}: {len(raw_meetings)} listed", flush=True)
    raw_meetings.sort(key=lambda m: m.get("date") or "9999")
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
        should_open = hit_title or (
            (inspect_body or inspect_all)
            and decision
            and (inspect_all or not day or date.fromisoformat(day) <= horizon)
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
        relevant = bool(keywords or snippets or hit_title)
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
            issue = f"Agenda or title flagged for: {', '.join(keywords) or 'data centre terms'}."
        elif decision:
            # Keep a thin 'scan' card only for upcoming decision bodies with no keyword hit
            if status != "upcoming":
                continue
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
                "id": f"es-{portal['id']}-{mtg['id'][:12]}",
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
                "why": why_for(keywords) if relevant else "Public council / planning meetings are where zoning and servicing get decided — often with little notice.",
                "participate": part,
                "links": {
                    "meeting": mtg["url"],
                    "agenda": mtg["url"],
                },
                "keywordsMatched": keywords,
                "relevant": relevant,
                "source": "escribe",
                "curated": False,
            }
        )
    return items


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--priority", default="all", help="all | high | medium (includes high)")
    ap.add_argument("--days", type=int, default=75, help="Look this many days ahead")
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
        if kind != "escribe":
            coverage.append(row)
            continue
        try:
            found = scrape_escribe(portal, horizon, args.inspect_all)
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

    merged = merge_items(curated, scraped)

    def sort_key(it: dict) -> tuple:
        upcoming = 0 if it.get("status") == "upcoming" else 1 if it.get("status") == "watch" else 2
        return (upcoming, it.get("date") or "9999", it.get("municipality") or "")

    merged.sort(key=sort_key)

    payload = {
        "asOf": datetime.now(timezone.utc).date().isoformat(),
        "note": (
            "Auto-polled eScribe calendars plus curated items. "
            "Keyword hits are flagged relevant; other upcoming council/planning meetings are listed so organizers can scan agendas. "
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
